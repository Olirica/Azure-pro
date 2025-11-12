import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { AdminApp } from './pages/Admin'

function AppRouter() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (path.startsWith('/admin')) {
    return <AdminApp />
  }
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">Client Shell</h1>
      <p className="text-slate-400">Open <code>/admin</code> to use the Admin UI.</p>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>
)

