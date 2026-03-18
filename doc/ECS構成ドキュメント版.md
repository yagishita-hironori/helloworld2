# ECS構成ドキュメント版  
**React SPA + ASP.NET Core API + RDS(SQL Server)**

## 1. 目的

本書は、以下の要件を満たす Web アプリケーションを **AWS ECS(Fargate)** 上で実行するための、実務向けの基本構成を整理したものです。

- フロントエンド: **React SPA**
- バックエンド: **ASP.NET Core API**
- DB: **Amazon RDS for SQL Server**
- 公開経路: **ALB(Application Load Balancer)**
- コンテナ実行基盤: **ECS on Fargate**

本書は、設計レビューのたたき台として利用できる粒度を想定しています。

---

## 2. 全体構成

```text
[ User / Browser ]
        │
        │ HTTPS
        ▼
+----------------------+
|   ALB                |
|  (Application Load   |
|   Balancer)          |
+----------------------+
        │
        │ ルーティング
        ├─────────────────────────────┐
        │                             │
        │ /                           │ /api/*
        ▼                             ▼
+----------------------+     +----------------------+
| ECS Service          |     | ECS Service          |
| frontend             |     | backend              |
| React SPA            |     | ASP.NET Core API     |
| (Fargate)            |     | (Fargate)            |
+----------------------+     +----------------------+
| Nginx                |     | ASP.NET Core         |
| static file serving  |     | Kestrel              |
+----------------------+     +----------------------+
                                      │
                                      │ SQL
                                      ▼
                              +----------------------+
                              | Amazon RDS           |
                              | SQL Server           |
                              +----------------------+
```

---

## 3. 採用方針

### 3.1 frontend
- React は SPA としてビルドする
- 実行時は **Nginx コンテナ**で静的ファイル配信する
- Node.js は **ビルド時のみ**利用し、実行時コンテナからは外す

### 3.2 backend
- ASP.NET Core は API 専用とする
- `/api/*` を受け、JSON を返す
- DB 接続情報は環境変数または Secrets Manager 経由で注入する

### 3.3 ルーティング
- ALB でパスベースルーティングを行う
- `/` 系は frontend
- `/api/*` は backend

### 3.4 ネットワーク
- ALB は Public Subnet
- ECS Tasks と RDS は Private Subnet
- RDS は backend からのみ接続許可

---

## 4. 詳細構成図

```text
┌───────────────────────────────────────────────┐
│ Internet                                      │
└───────────────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│ Route 53 / 独自ドメイン                        │
└───────────────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│ ALB                                            │
│ - 443(HTTPS)                                   │
│ - 証明書: ACM                                  │
│ - Listener Rule:                               │
│    /        → frontend target group            │
│    /api/*   → backend target group             │
└───────────────────────────────────────────────┘
             │                            │
             │                            │
             ▼                            ▼
┌───────────────────────┐      ┌───────────────────────┐
│ ECS Service           │      │ ECS Service           │
│ frontend              │      │ backend               │
│ desired count: 2      │      │ desired count: 2      │
└───────────────────────┘      └───────────────────────┘
             │                            │
             ▼                            ▼
┌───────────────────────┐      ┌───────────────────────┐
│ Fargate Task          │      │ Fargate Task          │
│ React build成果物配信 │      │ ASP.NET Core API      │
│ Nginx                 │      │ .NET Runtime          │
└───────────────────────┘      └───────────────────────┘
                                          │
                                          ▼
                               ┌───────────────────────┐
                               │ Amazon RDS            │
                               │ SQL Server            │
                               └───────────────────────┘
```

---

## 5. 通信の流れ

### 5.1 画面表示
```text
1. ブラウザが https://app.example.com/ にアクセス
2. ALB が frontend target group へ転送
3. frontend コンテナが index.html / js / css を返す
4. ブラウザ上で React SPA が起動
```

### 5.2 API 呼び出し
```text
1. React が /api/orders を呼ぶ
2. ALB が backend target group へ転送
3. ASP.NET Core API が処理
4. RDS SQL Server へアクセス
5. JSON を返す
6. React が画面を更新
```

---

## 6. ECS 用ディレクトリ構成例

```text
project-root/
├─ docs/
│  └─ ecs-architecture.md
├─ frontend/
│  ├─ Dockerfile
│  ├─ nginx.conf
│  ├─ package.json
│  ├─ package-lock.json
│  ├─ public/
│  └─ src/
├─ backend/
│  ├─ Dockerfile
│  ├─ MyApp.Api.csproj
│  ├─ Program.cs
│  ├─ appsettings.json
│  ├─ appsettings.Production.json
│  ├─ Controllers/
│  ├─ Services/
│  └─ Models/
├─ infrastructure/
│  ├─ alb/
│  │  └─ listener-rule-example.md
│  ├─ ecs/
│  │  ├─ taskdef-frontend.json
│  │  └─ taskdef-backend.json
│  └─ env/
│     ├─ frontend.env.example
│     └─ backend.env.example
└─ README.md
```

### 補足
- `frontend/` と `backend/` は独立してビルド可能にする
- `infrastructure/` 配下に ECS / ALB / 環境変数の雛形を置く
- 本番値は Git 管理せず、Secrets Manager や CI/CD から注入する

---

## 7. React frontend の Dockerfile

以下は **Node でビルドし、Nginx で配信する**マルチステージ構成です。

### 7.1 Dockerfile

```dockerfile
# build stage
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# runtime stage
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

### 7.2 nginx.conf

React Router を利用する場合、SPA の直接アクセスで 404 にならないよう、`index.html` へフォールバックします。

```nginx
server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location /health {
        access_log off;
        return 200 "ok";
        add_header Content-Type text/plain;
    }
}
```

### 7.3 ポイント
- 実行時は Nginx のみで軽量
- Node はビルド専用
- `/health` を ALB のヘルスチェックに流用可能

---

## 8. ASP.NET Core API の Dockerfile

以下は **build/publish/runtime** を分離した基本形です。

### 8.1 Dockerfile

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

COPY ["MyApp.Api.csproj", "./"]
RUN dotnet restore "MyApp.Api.csproj"

COPY . .
RUN dotnet publish "MyApp.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app

COPY --from=build /app/publish .

EXPOSE 8080

ENV ASPNETCORE_URLS=http://+:8080

ENTRYPOINT ["dotnet", "MyApp.Api.dll"]
```

### 8.2 補足
- ECS/Fargate では `8080` のようなアプリ専用ポートを使うと整理しやすい
- 接続文字列や環境差分はイメージに埋め込まず、ECS の環境変数や Secrets で注入する

### 8.3 例: 想定環境変数
```text
ASPNETCORE_ENVIRONMENT=Production
ConnectionStrings__DefaultConnection=Server=xxxx.xxx.ap-northeast-1.rds.amazonaws.com,1433;Database=AppDb;User Id=app_user;Password=xxxxx;TrustServerCertificate=True
```

---

## 9. ALB の listener rule 例

### 9.1 ルール方針
- デフォルトは frontend target group
- `/api/*` は backend target group へ転送

### 9.2 例

```text
Listener: HTTPS : 443

Priority 10
IF Path is /api/*
THEN Forward to target-group-backend

Default action
Forward to target-group-frontend
```

### 9.3 イメージ

```text
https://app.example.com/           → frontend
https://app.example.com/orders     → frontend
https://app.example.com/api/users  → backend
https://app.example.com/api/auth   → backend
```

### 9.4 ヘルスチェック例
- frontend target group
  - Path: `/health`
  - Success code: `200`

- backend target group
  - Path: `/health`
  - Success code: `200`

### 9.5 API 側ヘルスチェック実装例
```csharp
app.MapGet("/health", () => Results.Ok("ok"));
```

---

## 10. ECS task definition サンプル

以下は最小限の考え方を示す雛形です。  
実運用では IAM Role、Log Group、Secrets、CPU/Memory の見直しを行ってください。

### 10.1 frontend task definition 例

```json
{
  "family": "myapp-frontend",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::123456789012:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "frontend",
      "image": "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/myapp-frontend:latest",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 80,
          "protocol": "tcp"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/myapp-frontend",
          "awslogs-region": "ap-northeast-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

### 10.2 backend task definition 例

```json
{
  "family": "myapp-backend",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::123456789012:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::123456789012:role/myapp-backend-task-role",
  "containerDefinitions": [
    {
      "name": "backend",
      "image": "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/myapp-backend:latest",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 8080,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "ASPNETCORE_ENVIRONMENT",
          "value": "Production"
        }
      ],
      "secrets": [
        {
          "name": "ConnectionStrings__DefaultConnection",
          "valueFrom": "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:myapp/sqlserver-xxxxx"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/myapp-backend",
          "awslogs-region": "ap-northeast-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

### 10.3 注意点
- `latest` 固定ではなく、実運用では Git SHA やリリース番号のタグを使う
- backend は DB 接続のため、Secrets Manager 利用を推奨
- frontend は静的配信のため、必要最小限の CPU/Memory から始めやすい

---

## 11. セキュリティグループ方針

```text
Internet
  ↓ 443
ALB SG
  ↓ 80
Frontend ECS SG

ALB SG
  ↓ 8080
Backend ECS SG

Backend ECS SG
  ↓ 1433
RDS SG
```

### 方針
- ALB のみ Public
- frontend/backend は ALB からのみ通信許可
- RDS は backend からのみ 1433 を許可
- backend への直接公開はしない

---

## 12. ネットワーク配置

```text
VPC
├─ Public Subnet
│  └─ ALB
└─ Private Subnet
   ├─ ECS frontend tasks
   ├─ ECS backend tasks
   └─ RDS SQL Server
```

### 推奨
- Multi-AZ を前提に、各層を 2AZ 以上に分散
- NAT Gateway / VPC Endpoint の要否は、ECR pull や外部通信要件に応じて判断

---

## 13. ログ/監視の基本

### frontend
- Nginx アクセスログ/エラーログを CloudWatch Logs へ送信

### backend
- ASP.NET Core アプリログを CloudWatch Logs へ送信
- 必要に応じて構造化ログ(JSON)を採用

### 監視項目例
- ALB 5xx
- Target response time
- ECS CPU / Memory
- RDS CPU / Storage / Connections
- backend のアプリ例外件数

---

## 14. 運用上の注意点

### 14.1 SPA ルーティング
React Router を使う場合、frontend 側で `index.html` フォールバックが必須

### 14.2 CORS
`/` と `/api` を同一 ALB / 同一ドメイン配下に置くことで、CORS 問題を避けやすい

### 14.3 認証
早期に方式を決めることを推奨
- Cookie 認証
- JWT
- Amazon Cognito
- Entra ID / Azure AD

### 14.4 セッション
コンテナローカルに保持しない
- JWT
- Redis
- サーバー側セッション共有
のいずれかを検討

### 14.5 アップロードファイル
ECS コンテナ内に永続保存しない
- S3 保存を原則とする

---

## 15. この構成のメリット

### 15.1 責務分離
- frontend は UI 配信に集中
- backend は API に集中
- DB は RDS に分離

### 15.2 デプロイ独立
- frontend だけ差し替え可能
- backend だけ差し替え可能

### 15.3 スケーリング容易
- frontend と backend を別々にスケールできる
- 負荷特性の違いに対応しやすい

### 15.4 実務で扱いやすい
- ECS/Fargate の基本形に沿う
- パスベースルーティングで理解しやすい
- React と ASP.NET Core の役割が明確

---

## 16. リスク/論点

- frontend を ECS 配信にするか、S3 + CloudFront にするかは別途検討余地あり
- 認証/認可の方式で実装パターンが大きく変わる
- BFF を設けるかは将来の複雑性次第
- SQL Server ライセンス/コストは事前確認が必要

---

## 17. 完成イメージ

```text
https://app.example.com/       → React SPA
https://app.example.com/api/*  → ASP.NET Core API
```

---

## 18. まとめ

```text
Internet
   ↓
ALB
   ├─ /      → ECS frontend service (React SPA)
   └─ /api/* → ECS backend service (ASP.NET Core API)
                         ↓
                    RDS SQL Server
```

この構成は、**業務アプリで React の操作性を活かしつつ、ASP.NET Core を API に専念させる**実務的な基本形です。  
設計レビューの初版としては、まずこの構成を基準案とし、認証方式・ファイル保存方式・監視要件を追加で詰める進め方が現実的です。
