import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { AdminApp } from './pages/Admin'
import { ListenerApp } from './pages/Listener'
import { SpeakerApp } from './pages/Speaker'
import { LandingApp } from './pages/Landing'

function AppRouter() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (path.startsWith('/admin')) {
    return <AdminApp />
  }
  if (path.startsWith('/listener') || path.startsWith('/listener.html')) {
    return <ListenerApp />
  }
  if (path.startsWith('/speaker') || path.startsWith('/speaker.html')) {
    return <SpeakerApp />
  }
  return <LandingApp />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>
)

