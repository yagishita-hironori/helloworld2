async function getHello() {
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
    const res = await fetch(`${backendUrl}/api/hello`, { cache: 'no-store' });
    const data = await res.json();
    return data.message;
  } catch {
    return 'API に接続できませんでした';
  }
}

export default async function Home() {
  const message = await getHello();

  return (
    <div style={{ textAlign: 'center', marginTop: '4rem', fontFamily: 'sans-serif' }}>
      <h1>{message}</h1>
      <p>React SPA (Next.js) + ASP.NET Core API on ECS/Fargate2</p>
    </div>
  );
}
