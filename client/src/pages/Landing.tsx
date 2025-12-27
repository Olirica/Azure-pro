import React, { useEffect, useState } from 'react'

// ============================================================================
// Aurora Glass Design System
// ============================================================================
const glassPanel = "relative backdrop-blur-xl bg-white/[0.03] border border-white/[0.08] rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)]"
const glassInput = "w-full bg-white/[0.03] backdrop-blur border border-white/[0.1] rounded-xl px-4 py-3 text-white/90 placeholder:text-white/30 focus:outline-none focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/30 transition-all duration-200"
const btnPrimary = "relative px-6 py-3 rounded-xl font-semibold text-sm tracking-wide transition-all duration-200 bg-gradient-to-br from-cyan-500/80 to-teal-600/80 text-white shadow-[0_4px_20px_rgba(20,184,166,0.3),inset_0_1px_0_rgba(255,255,255,0.2)] hover:shadow-[0_6px_24px_rgba(20,184,166,0.4),inset_0_1px_0_rgba(255,255,255,0.3)] hover:translate-y-[-1px] active:translate-y-[1px] active:shadow-[0_2px_12px_rgba(20,184,166,0.3),inset_0_1px_0_rgba(255,255,255,0.1)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0"
const btnSecondary = "px-5 py-3 rounded-xl text-sm font-medium transition-all duration-200 bg-white/[0.03] border border-white/[0.1] text-white/70 hover:bg-white/[0.06] hover:border-white/[0.15] hover:text-white/90"

interface RoleCardProps {
  icon: React.ReactNode
  title: string
  description: string
  href: string
  accentColor: 'cyan' | 'violet' | 'amber'
  delay?: number
}

const RoleCard = ({ icon, title, description, href, accentColor, delay = 0 }: RoleCardProps) => {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), delay)
    return () => clearTimeout(timer)
  }, [delay])

  const colorMap = {
    cyan: {
      border: 'hover:border-cyan-400/30',
      glow: 'group-hover:shadow-[0_0_60px_rgba(6,182,212,0.15)]',
      icon: 'text-cyan-400',
      iconBg: 'from-cyan-500/20 to-teal-500/20 border-cyan-400/20'
    },
    violet: {
      border: 'hover:border-violet-400/30',
      glow: 'group-hover:shadow-[0_0_60px_rgba(139,92,246,0.15)]',
      icon: 'text-violet-400',
      iconBg: 'from-violet-500/20 to-purple-500/20 border-violet-400/20'
    },
    amber: {
      border: 'hover:border-amber-400/30',
      glow: 'group-hover:shadow-[0_0_60px_rgba(251,191,36,0.15)]',
      icon: 'text-amber-400',
      iconBg: 'from-amber-500/20 to-orange-500/20 border-amber-400/20'
    }
  }

  const colors = colorMap[accentColor]

  return (
    <a
      href={href}
      className={`group block ${glassPanel} p-6 transition-all duration-500 ${colors.border} ${colors.glow} ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}
    >
      <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${colors.iconBg} border flex items-center justify-center mb-5 transition-transform duration-300 group-hover:scale-110`}>
        <div className={colors.icon}>{icon}</div>
      </div>
      <h3 className="text-xl font-semibold text-white/90 mb-2" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
      <p className="text-white/40 text-sm leading-relaxed">{description}</p>
      <div className={`mt-4 flex items-center gap-2 ${colors.icon} text-sm font-medium opacity-0 group-hover:opacity-100 transition-opacity duration-300`}>
        <span>Enter</span>
        <svg className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
        </svg>
      </div>
    </a>
  )
}

export function LandingApp() {
  const [roomCode, setRoomCode] = useState('')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    document.title = 'Simo - Real-time Translation'
    setMounted(true)
  }, [])

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault()
    if (roomCode.trim()) {
      window.location.href = `/listener?room=${encodeURIComponent(roomCode.trim().toLowerCase())}`
    }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=DM+Sans:wght@400;500;600&display=swap');
        @keyframes aurora { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
        @keyframes float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
        @keyframes pulse-slow { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.8; } }
        @keyframes gradient-shift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        .aurora-bg { background: linear-gradient(-45deg, #0a0f1c, #1a1f3c, #0f172a, #1e1b4b, #0c1929); background-size: 400% 400%; animation: aurora 20s ease infinite; }
        .float-animation { animation: float 6s ease-in-out infinite; }
        .pulse-slow { animation: pulse-slow 4s ease-in-out infinite; }
        .gradient-text { background: linear-gradient(135deg, #06b6d4, #14b8a6, #a855f7, #06b6d4); background-size: 300% 300%; animation: gradient-shift 8s ease infinite; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
      `}</style>

      <main className="aurora-bg min-h-screen relative overflow-hidden" style={{ fontFamily: "'DM Sans', sans-serif" }}>
        {/* Ambient Orbs */}
        <div className="absolute top-20 left-10 w-72 h-72 bg-cyan-500/10 rounded-full blur-3xl pulse-slow" />
        <div className="absolute bottom-20 right-10 w-96 h-96 bg-violet-500/10 rounded-full blur-3xl pulse-slow" style={{ animationDelay: '2s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-teal-500/5 rounded-full blur-3xl" />

        <div className="relative z-10 container mx-auto px-4 py-12 min-h-screen flex flex-col">
          {/* Hero Section */}
          <header className={`text-center mb-16 transition-all duration-1000 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
            <div className="float-animation w-24 h-24 mx-auto mb-8 rounded-3xl bg-gradient-to-br from-cyan-500/20 to-violet-500/20 border border-white/10 flex items-center justify-center shadow-[0_0_60px_rgba(6,182,212,0.2)]">
              <svg className="w-12 h-12 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
              </svg>
            </div>
            <h1 className="text-5xl md:text-6xl font-bold mb-4" style={{ fontFamily: "'Outfit', sans-serif" }}>
              <span className="gradient-text">Simo</span>
            </h1>
            <p className="text-white/50 text-lg md:text-xl max-w-xl mx-auto leading-relaxed">
              Real-time multilingual speech translation for conferences, meetings, and live events
            </p>
          </header>

          {/* Quick Join */}
          <div className={`max-w-md mx-auto mb-16 transition-all duration-1000 delay-200 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
            <form onSubmit={handleJoinRoom} className={`${glassPanel} p-6`}>
              <label className="block text-white/50 text-xs font-medium uppercase tracking-wider mb-3 text-center">Quick Join</label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value)}
                  placeholder="Enter room code"
                  className={`${glassInput} text-center flex-1`}
                />
                <button type="submit" className={btnPrimary} disabled={!roomCode.trim()}>
                  Join
                </button>
              </div>
            </form>
          </div>

          {/* Role Cards */}
          <div className="flex-1 flex items-center justify-center">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl w-full">
              <RoleCard
                icon={
                  <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                }
                title="Speaker"
                description="Broadcast your speech to be transcribed and translated in real-time for your audience"
                href="/speaker"
                accentColor="cyan"
                delay={300}
              />
              <RoleCard
                icon={
                  <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15.536a5 5 0 001.414 1.414m2.828-9.9a9 9 0 012.828-2.828" />
                    <circle cx="12" cy="12" r="3" strokeWidth={1.5} />
                  </svg>
                }
                title="Listener"
                description="Follow along with live captions and audio translation in your preferred language"
                href="/listener"
                accentColor="violet"
                delay={450}
              />
              <RoleCard
                icon={
                  <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                }
                title="Admin"
                description="Configure rooms, manage languages, and customize translation settings"
                href="/admin"
                accentColor="amber"
                delay={600}
              />
            </div>
          </div>

          {/* Footer */}
          <footer className={`text-center mt-16 transition-all duration-1000 delay-700 ${mounted ? 'opacity-100' : 'opacity-0'}`}>
            <div className="flex items-center justify-center gap-6 text-white/30 text-sm">
              <span>Real-time STT</span>
              <span className="w-1 h-1 rounded-full bg-white/20" />
              <span>AI Translation</span>
              <span className="w-1 h-1 rounded-full bg-white/20" />
              <span>Neural TTS</span>
            </div>
          </footer>
        </div>
      </main>
    </>
  )
}
