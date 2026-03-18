# GitHub Actions デプロイ設定手順書

**作成日:** 2026-03-18
**対象リポジトリ:** https://github.com/yagishita-hironori/helloworld2
**AWS アカウント ID:** 869935101124
**AWS リージョン:** ap-northeast-1 (東京)

---

## 概要

`main` ブランチへの push をトリガーに、GitHub Actions が自動的に Docker イメージをビルドして ECR に push し、ECS サービスをローリングアップデートする CI/CD 環境の構築手順。

AWS への認証は **OIDC (OpenID Connect)** を使用し、長期的な AWS アクセスキーを管理しない。

```
git push origin main
  │
  ├─ frontend/** 変更 → deploy-frontend.yml 起動
  │    Docker build → ECR push → ECS ローリングアップデート
  │
  └─ backend/** 変更 → deploy-backend.yml 起動
       Docker build → ECR push → ECS ローリングアップデート
```

---

## beans-web-test との主な差分

| 項目 | beans-web-test (元) | beans-web-test2 (本プロジェクト) |
|---|---|---|
| フロントエンド | React SPA / Nginx | Next.js / Node.js |
| コンテナポート | 80 | 3000 |
| フロントエCS メモリ | 512 MB | 1024 MB |
| ECR リポジトリ | helloworld-frontend/backend | helloworld2-frontend/backend |
| ECS クラスター | helloworld-cluster | helloworld2-cluster |
| ヘルスチェック実装 | Nginx の location /health | Next.js Route Handler |

---

## 前提条件

- AWS CLI がインストール済みで、必要な権限を持つユーザーでログインしていること
- 元プロジェクト (beans-web-test) の VPC・サブネット・ALB が作成済みであること
- GitHub リポジトリ (`helloworld2`) が作成済みであること

---

## Step 1: アプリケーションコードの修正

### 1-1. ヘルスチェックエンドポイントの追加

Next.js には Nginx のような組み込みヘルスチェック機能がないため、Route Handler で実装する。

`frontend/app/health/route.js` を作成:

```js
export async function GET() {
  return new Response('ok', { status: 200 });
}
```

> **注意:** `/api/health` ではなく `/health` に配置すること。ALB のリスナールールで `/api/*` はバックエンドに転送されるため、`/api/health` はフロントエンドに届かない。

### 1-2. バックエンド URL の環境変数化

`frontend/app/page.jsx` の API 呼び出しをハードコードから環境変数に変更:

```js
// 変更前
const res = await fetch('http://localhost:5000/api/hello', { cache: 'no-store' });

// 変更後
const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
const res = await fetch(`${backendUrl}/api/hello`, { cache: 'no-store' });
```

### 1-3. Dockerfile の修正

`frontend/Dockerfile` の runtime ステージから存在しない `public/` ディレクトリのコピーを削除:

```dockerfile
# 削除する行
COPY --from=build /app/public ./public
```

---

## Step 2: ECR リポジトリを作成する

```bash
aws ecr create-repository --repository-name helloworld2-frontend --region ap-northeast-1
aws ecr create-repository --repository-name helloworld2-backend  --region ap-northeast-1
```

---

## Step 3: CloudWatch Logs グループを作成する

```bash
aws logs create-log-group --log-group-name /ecs/helloworld2-frontend --region ap-northeast-1
aws logs create-log-group --log-group-name /ecs/helloworld2-backend  --region ap-northeast-1
```

---

## Step 4: ECS クラスターを作成する

```bash
aws ecs create-cluster --cluster-name helloworld2-cluster --region ap-northeast-1
```

---

## Step 5: セキュリティグループを作成する

元プロジェクトの ALB SG (`sg-0c289176d3f0c997b`) からの通信を許可する。
フロントエンドのポートが **80 → 3000** に変わっている点に注意。

```bash
# フロントエンド用 SG（ポート 3000）
aws ec2 create-security-group \
  --group-name helloworld2-frontend-sg \
  --description "helloworld2 frontend ECS SG" \
  --vpc-id vpc-0fd0c9087e34aeff0

aws ec2 authorize-security-group-ingress \
  --group-id <FRONTEND_SG_ID> \
  --protocol tcp --port 3000 \
  --source-group sg-0c289176d3f0c997b

# バックエンド用 SG（ポート 8080）
aws ec2 create-security-group \
  --group-name helloworld2-backend-sg \
  --description "helloworld2 backend ECS SG" \
  --vpc-id vpc-0fd0c9087e34aeff0

aws ec2 authorize-security-group-ingress \
  --group-id <BACKEND_SG_ID> \
  --protocol tcp --port 8080 \
  --source-group sg-0c289176d3f0c997b
```

---

## Step 6: ターゲットグループを作成する

```bash
# フロントエンド用（ポート 3000）
aws elbv2 create-target-group \
  --name helloworld2-frontend-tg \
  --protocol HTTP \
  --port 3000 \
  --target-type ip \
  --vpc-id vpc-0fd0c9087e34aeff0 \
  --health-check-path /health \
  --region ap-northeast-1

# バックエンド用（ポート 8080）
aws elbv2 create-target-group \
  --name helloworld2-backend-tg \
  --protocol HTTP \
  --port 8080 \
  --target-type ip \
  --vpc-id vpc-0fd0c9087e34aeff0 \
  --health-check-path /health \
  --region ap-northeast-1
```

> **注意:** ターゲットグループ作成後、ALB リスナーへの紐付けを先に完了してから ECS サービスを作成すること（順序を誤ると `InvalidParameterException` が発生する）。

---

## Step 7: ALB リスナーを設定する

既存の ALB リスナーのデフォルトアクションをフロントエンド TG に向け、`/api/*` をバックエンド TG に転送するルールを追加する。

```bash
# デフォルトアクションをフロントエンド TG に変更
aws elbv2 modify-listener \
  --listener-arn arn:aws:elasticloadbalancing:ap-northeast-1:869935101124:listener/app/helloworld-alb/bce042332b67c396/f00bc3088ba256df \
  --default-actions Type=forward,TargetGroupArn=<FRONTEND_TG_ARN> \
  --region ap-northeast-1

# /api/* をバックエンド TG に転送するルールを追加
aws elbv2 create-rule \
  --listener-arn arn:aws:elasticloadbalancing:ap-northeast-1:869935101124:listener/app/helloworld-alb/bce042332b67c396/f00bc3088ba256df \
  --priority 20 \
  --conditions '[{"Field":"path-pattern","Values":["/api/*"]}]' \
  --actions '[{"Type":"forward","TargetGroupArn":"<BACKEND_TG_ARN>"}]' \
  --region ap-northeast-1
```

> **権限が不足している場合:** AWS コンソール (EC2 → Load Balancers → Listeners) から手動で設定する。

---

## Step 8: ECS タスク定義を登録する

`infrastructure/ecs/taskdef-frontend.json` の `BACKEND_URL` には ALB の URL を設定する。
Next.js の SSR はサーバーサイドでバックエンドを呼び出すため、`localhost` や ECS サービス名（サービスディスカバリー未設定時）は使用できない。

```json
{
  "name": "BACKEND_URL",
  "value": "http://helloworld-alb-407709868.ap-northeast-1.elb.amazonaws.com"
}
```

タスク定義を登録:

```bash
aws ecs register-task-definition \
  --cli-input-json file://infrastructure/ecs/taskdef-frontend.json \
  --region ap-northeast-1

aws ecs register-task-definition \
  --cli-input-json file://infrastructure/ecs/taskdef-backend.json \
  --region ap-northeast-1
```

---

## Step 9: ECS サービスを作成する

> **重要:** Step 7 の ALB リスナー設定を完了してから実行すること。

```bash
# フロントエンド
aws ecs create-service \
  --cluster helloworld2-cluster \
  --service-name helloworld2-frontend-service \
  --task-definition helloworld2-frontend \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-0fa641440660db889,subnet-0c55a4e73f31be9b7],securityGroups=[<FRONTEND_SG_ID>],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=<FRONTEND_TG_ARN>,containerName=frontend,containerPort=3000" \
  --region ap-northeast-1

# バックエンド
aws ecs create-service \
  --cluster helloworld2-cluster \
  --service-name helloworld2-backend-service \
  --task-definition helloworld2-backend \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-0fa641440660db889,subnet-0c55a4e73f31be9b7],securityGroups=[<BACKEND_SG_ID>],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=<BACKEND_TG_ARN>,containerName=backend,containerPort=8080" \
  --region ap-northeast-1
```

---

## Step 10: OIDC と IAM ロールを設定する

### 10-1. 信頼ポリシーファイルを確認する

`infrastructure/github-oidc/trust-policy-helloworld2.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::869935101124:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:yagishita-hironori/helloworld2:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

### 10-2. IAM ロールを作成してポリシーをアタッチする

```bash
aws iam create-role \
  --role-name github-actions-helloworld2-deploy \
  --assume-role-policy-document file://infrastructure/github-oidc/trust-policy-helloworld2.json

aws iam create-policy \
  --policy-name helloworld2-deploy-policy \
  --policy-document file://infrastructure/github-oidc/deploy-permissions-policy-helloworld2.json

aws iam attach-role-policy \
  --role-name github-actions-helloworld2-deploy \
  --policy-arn arn:aws:iam::869935101124:policy/helloworld2-deploy-policy
```

`infrastructure/github-oidc/deploy-permissions-policy-helloworld2.json` の権限内容:

| Sid | 権限 | 対象リソース |
|---|---|---|
| ECRAuth | ECR 認証トークン取得 | * |
| ECRPush | ECR へのイメージ push | helloworld2-frontend / helloworld2-backend |
| ECSDeployRead | ECS タスク定義・サービスの参照 | * |
| ECSDeployWrite | ECS タスク定義の登録・サービス更新 | * |
| PassRoleToECS | ECS タスクへのロール付与 | ecsTaskExecutionRole / helloworld-backend-task-role |

---

## Step 11: GitHub Secret を登録する

`https://github.com/yagishita-hironori/helloworld2/settings/secrets/actions` にアクセスして登録:

| Secret 名 | 値 |
|---|---|
| `AWS_ROLE_ARN` | `arn:aws:iam::869935101124:role/github-actions-helloworld2-deploy` |

---

## Step 12: Git リポジトリを初期化して push する

```bash
git init
git branch -M main
git remote add origin https://github.com/yagishita-hironori/helloworld2.git
git add .
git commit -m "initial commit"
git push -u origin main
```

push 後、`frontend/**` と `backend/**` の変更が含まれるため両ワークフローが起動する。

---

## 動作確認

| エンドポイント | 期待する結果 |
|---|---|
| `http://helloworld-alb-407709868.ap-northeast-1.elb.amazonaws.com` | Hello World のメッセージが表示される |
| `http://helloworld-alb-407709868.ap-northeast-1.elb.amazonaws.com/health` | `ok` が返る |
| `http://helloworld-alb-407709868.ap-northeast-1.elb.amazonaws.com/api/hello` | `{"message":"Hello World..."}` が返る |

---

## トラブルシューティング

### Dockerfile ビルドエラー: `/app/public` not found

Next.js プロジェクトに `public/` ディレクトリが存在しない場合に発生。
`frontend/Dockerfile` の以下の行を削除する:

```dockerfile
COPY --from=build /app/public ./public
```

### ECS サービス作成エラー: target group does not have an associated load balancer

ALB リスナーへの紐付け（Step 7）を先に完了してから ECS サービスを作成する。

### フロントエンドで「API に接続できませんでした」

`frontend/app/page.jsx` が `http://localhost:5000` にハードコードされている場合に発生。
`BACKEND_URL` 環境変数を使用するよう修正し、`taskdef-frontend.json` に ALB の URL を設定する。

### ヘルスチェック `/api/health` が 404

ALB のリスナールールで `/api/*` はバックエンドに転送されるため、フロントエンドのヘルスチェックは `/health` に配置する。
Next.js Route Handler は `frontend/app/health/route.js` に作成する。

### OIDC 認証エラー

```
Error: Could not assume role with OIDC
```

`trust-policy-helloworld2.json` のリポジトリ名・ブランチ名が一致していない。
IAM ロールの信頼ポリシーの `sub` 条件を確認する。

### ECR push エラー: ecr:InitiateLayerUpload

`helloworld2-deploy-policy` の ECRPush 権限が `helloworld2-frontend/backend` リポジトリを対象としているか確認する。
元プロジェクトの `helloworld-deploy-policy` は `helloworld-*` のみ対象のため流用不可。

---

## AWS リソース一覧

| リソース | 名前 / ID |
|---|---|
| ECR (frontend) | `helloworld2-frontend` |
| ECR (backend) | `helloworld2-backend` |
| ECS クラスター | `helloworld2-cluster` |
| ECS サービス (frontend) | `helloworld2-frontend-service` |
| ECS サービス (backend) | `helloworld2-backend-service` |
| CloudWatch Logs (frontend) | `/ecs/helloworld2-frontend` |
| CloudWatch Logs (backend) | `/ecs/helloworld2-backend` |
| IAM ロール | `github-actions-helloworld2-deploy` |
| IAM ポリシー | `helloworld2-deploy-policy` |
| ALB | `helloworld-alb`（元プロジェクトから流用） |
| VPC | `vpc-0fd0c9087e34aeff0`（元プロジェクトから流用） |
