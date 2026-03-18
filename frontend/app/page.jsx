'use client';

import { useEffect, useState } from 'react';

export default function Home() {
  const [message, setMessage] = useState('読み込み中...');

  useEffect(() => {
    fetch('/api/hello')
      .then(res => res.json())
      .then(data => setMessage(data.message))
      .catch(() => setMessage('API に接続できませんでした'));
  }, []);

  return (
    <div style={{ textAlign: 'center', marginTop: '4rem', fontFamily: 'sans-serif' }}>
      <h1>{message}</h1>
      <p>React SPA (Next.js) + ASP.NET Core API on ECS/Fargate</p>
    </div>
  );
}
