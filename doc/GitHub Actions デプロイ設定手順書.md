# GitHub Actions デプロイ設定手順書

**作成日:** 2026-03-18
**対象リポジトリ:** https://github.com/yagishita-hironori/helloworld
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

## 前提条件

- AWS CLI がインストール済みで、必要な権限を持つユーザーでログインしていること
- ECR リポジトリが作成済みであること
- ECS クラスター・サービスが作成済みであること
- GitHub リポジトリが作成済みであること

---

## Step 1: OIDC プロバイダーを AWS に登録する

GitHub Actions が AWS に認証するための OIDC プロバイダーを登録する。

```bash
aws iam create-open-id-connect-provider `
  --url https://token.actions.githubusercontent.com `
  --client-id-list sts.amazonaws.com `
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

> **注意:** すでに登録済みの場合はスキップしてください。

---

## Step 2: GitHub Actions 用 IAM ロールを作成する

### 2-1. 信頼ポリシーファイルを確認する

[infrastructure/github-oidc/oidc-role-policy.json](../infrastructure/github-oidc/oidc-role-policy.json) の内容:

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
          "token.actions.githubusercontent.com:sub": "repo:yagishita-hironori/helloworld:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

> **ポイント:** `sub` 条件により `yagishita-hironori/helloworld` リポジトリの `main` ブランチからのみ AssumeRole を許可している。

### 2-2. IAM ロールを作成する

```bash
aws iam create-role `
  --role-name github-actions-helloworld-deploy `
  --assume-role-policy-document file://C:/repos/beans-web-test/infrastructure/github-oidc/oidc-role-policy.json
```

---

## Step 3: デプロイ用 IAM ポリシーを作成してアタッチする

### 3-1. ポリシーファイルを確認する

[infrastructure/github-oidc/deploy-permissions-policy.json](../infrastructure/github-oidc/deploy-permissions-policy.json) の権限内容:

| Sid | 権限 | 対象リソース |
|---|---|---|
| ECRAuth | ECR 認証トークン取得 | * |
| ECRPush | ECR へのイメージ push | helloworld-frontend / helloworld-backend リポジトリ |
| ECSDeployRead | ECS タスク定義・サービスの参照 | * |
| ECSDeployWrite | ECS タスク定義の登録・サービス更新 | * |
| PassRoleToECS | ECS タスクへのロール付与 | ecsTaskExecutionRole / helloworld-backend-task-role |

### 3-2. ポリシーを作成してロールにアタッチする

```bash
aws iam create-policy `
  --policy-name helloworld-deploy-policy `
  --policy-document file://C:/repos/beans-web-test/infrastructure/github-oidc/deploy-permissions-policy.json

aws iam attach-role-policy `
  --role-name github-actions-helloworld-deploy `
  --policy-arn arn:aws:iam::869935101124:policy/helloworld-deploy-policy
```

### 3-3. ロール ARN を確認する

```bash
aws iam get-role `
  --role-name github-actions-helloworld-deploy `
  --query 'Role.Arn' `
  --output text
# → arn:aws:iam::869935101124:role/github-actions-helloworld-deploy
```

---

## Step 4: GitHub Secret を登録する

GitHub リポジトリの **Settings → Secrets and variables → Actions → New repository secret** に以下を登録する。

| Secret 名 | 値 |
|---|---|
| `AWS_ROLE_ARN` | `arn:aws:iam::869935101124:role/github-actions-helloworld-deploy` |

設定画面の URL:
```
https://github.com/yagishita-hironori/helloworld/settings/secrets/actions
```

---

## Step 5: GitHub Actions ワークフローを確認する

### フロントエンド: deploy-frontend.yml

**トリガー:** `frontend/**` または `.github/workflows/deploy-frontend.yml` が変更されて `main` に push された場合

**環境変数:**

| 変数名 | 値 |
|---|---|
| AWS_REGION | ap-northeast-1 |
| ECR_REPOSITORY | helloworld-frontend |
| ECS_CLUSTER | helloworld-cluster |
| ECS_SERVICE | helloworld-frontend-service |
| CONTAINER_NAME | frontend |
| TASK_DEFINITION | infrastructure/ecs/taskdef-frontend.json |

**実行ステップ:**

1. Checkout
2. AWS 認証 (OIDC)
3. ECR ログイン
4. Docker ビルド & ECR push (タグ: git commit SHA)
5. ECS タスク定義を新イメージで更新
6. ECS サービス ローリングアップデート (安定確認まで待機)

### バックエンド: deploy-backend.yml

**トリガー:** `backend/**` または `.github/workflows/deploy-backend.yml` が変更されて `main` に push された場合

**環境変数:**

| 変数名 | 値 |
|---|---|
| AWS_REGION | ap-northeast-1 |
| ECR_REPOSITORY | helloworld-backend |
| ECS_CLUSTER | helloworld-cluster |
| ECS_SERVICE | helloworld-backend-service |
| CONTAINER_NAME | backend |
| TASK_DEFINITION | infrastructure/ecs/taskdef-backend.json |

**実行ステップ:** フロントエンドと同様

---

## Step 6: 動作確認

`frontend/` または `backend/` 配下のファイルを変更して `main` に push する。

```bash
git add frontend/   # または backend/
git commit -m "任意のメッセージ"
git push origin main
```

GitHub Actions の実行状況を確認する:
```
https://github.com/yagishita-hironori/helloworld/actions
```

デプロイ完了後、ALB の URL でアクセスして動作確認する:
```
http://helloworld-alb-407709868.ap-northeast-1.elb.amazonaws.com
```

---

## トラブルシューティング

### OIDC 認証エラー

```
Error: Could not assume role with OIDC
```

**原因:** `oidc-role-policy.json` のリポジトリ名・ブランチ名が一致していない
**対処:** IAM ロールの信頼ポリシーの `sub` 条件を確認する

### ECR push エラー

```
Error: denied: User is not authorized to perform: ecr:InitiateLayerUpload
```

**原因:** `helloworld-deploy-policy` の ECRPush 権限が不足している
**対処:** `deploy-permissions-policy.json` の `Resource` に対象リポジトリが含まれているか確認する

### ECS デプロイが安定しない

```
Error: Service did not stabilize
```

**原因:** 新しいタスクが起動に失敗している
**対処:** AWS コンソールの ECS サービスイベントまたは CloudWatch Logs (`/ecs/helloworld-frontend`, `/ecs/helloworld-backend`) でエラー内容を確認する
