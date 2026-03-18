# Hello World - ECS/Fargate サンプル (Next.js版)

Next.js + ASP.NET Core API + RDS(SQL Server) の ECS/Fargate 構成サンプルです。

## 構成

```
[ ブラウザ ]
     │ HTTP
     ▼
   ALB
     ├─ /       → frontend (Next.js / Node.js)
     └─ /api/*  → backend  (ASP.NET Core API)
                                 ↓
                           RDS SQL Server
```

## ディレクトリ

```
.
├─ frontend/          # Next.js App Router
│  ├─ Dockerfile
│  ├─ next.config.js
│  ├─ package.json
│  └─ app/
│     ├─ layout.jsx
│     └─ page.jsx     # /api/hello を呼んで表示
├─ backend/           # ASP.NET Core API
│  ├─ Dockerfile
│  ├─ HelloWorld.Api.csproj
│  └─ Program.cs
├─ infrastructure/
│  └─ ecs/
│     ├─ taskdef-frontend.json
│     └─ taskdef-backend.json
└─ .github/
   └─ workflows/
      ├─ deploy-frontend.yml
      └─ deploy-backend.yml
```

## ローカル動作確認

### backend

```bash
cd backend
dotnet run
# http://localhost:5000/api/hello
```

### frontend

```bash
cd frontend
npm install
npm run dev
# http://localhost:3000
```

## beans-web-test との主な違い

| 項目 | beans-web-test | beans-web-test2 |
|---|---|---|
| フロントエンド | React + Vite | Next.js 14 |
| レンダリング | CSR (クライアント) | SSR (サーバー) |
| Web サーバー | Nginx | Node.js |
| コンテナポート | 80 | 3000 |
| ECS メモリ | 512MB | 1024MB |
| ルーティング | react-router-dom | ファイルベース |
