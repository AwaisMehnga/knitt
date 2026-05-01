import { useEffect, useRef, useState } from 'react'
import './index.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const GOOGLE_SCOPE = 'openid email profile'
const CALLBACK_PATH = '/auth/google/callback'
const STATE_STORAGE_KEY = 'knitt_google_oauth_state'
const CSRF_COOKIE_NAME = 'knitt_csrf_token'

function getCallbackUrl() {
  return `${window.location.origin}${CALLBACK_PATH}`
}

function createGoogleState() {
  const values = crypto.getRandomValues(new Uint32Array(4))
  return Array.from(values, (value) => value.toString(16)).join('-')
}

function readCookie(name) {
  const match = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`))

  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : null
}

function App() {
  const [user, setUser] = useState(null)
  const [csrfToken, setCsrfToken] = useState(() => readCookie(CSRF_COOKIE_NAME))
  const [status, setStatus] = useState('Checking session...')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [avatarFailed, setAvatarFailed] = useState(false)

  const refreshPromiseRef = useRef(null)
  const logoutInFlightRef = useRef(false)

  function syncCsrfToken(nextCsrfToken) {
    setCsrfToken(nextCsrfToken || readCookie(CSRF_COOKIE_NAME))
  }

  function clearSession(message = 'Session expired. Please sign in again.') {
    setUser(null)
    setCsrfToken(null)
    setAvatarFailed(false)
    if (!logoutInFlightRef.current) {
      setStatus(message)
    }
  }

  async function refreshSession() {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current
    }

    const currentCsrfToken = readCookie(CSRF_COOKIE_NAME)
    if (!currentCsrfToken) {
      clearSession()
      return null
    }

    refreshPromiseRef.current = fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': currentCsrfToken,
      },
      body: JSON.stringify({}),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null)

        if (!response.ok) {
          throw new Error(payload?.message || 'Session expired. Please sign in again.')
        }

        syncCsrfToken(payload?.csrfToken)
        return payload
      })
      .catch((refreshError) => {
        clearSession(refreshError.message)
        throw refreshError
      })
      .finally(() => {
        refreshPromiseRef.current = null
      })

    return refreshPromiseRef.current
  }

  async function fetchCurrentUser(allowRefresh = true) {
    const response = await fetch(`${API_BASE_URL}/auth/me`, {
      method: 'GET',
      credentials: 'include',
    })

    const payload = await response.json().catch(() => null)

    if (response.status === 401 && allowRefresh) {
      const refreshed = await refreshSession()
      if (!refreshed) {
        return null
      }
      return fetchCurrentUser(false)
    }

    if (!response.ok) {
      throw new Error(payload?.message || 'Unable to load user details.')
    }

    setUser(payload.user)
    setAvatarFailed(false)
    setStatus('Signed in')
    setError('')
    syncCsrfToken()
    return payload.user
  }

  function handleGoogleLogin() {
    setError('')
    setStatus('Redirecting to Google...')

    const state = createGoogleState()
    sessionStorage.setItem(STATE_STORAGE_KEY, state)

    const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    googleUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID)
    googleUrl.searchParams.set('redirect_uri', getCallbackUrl())
    googleUrl.searchParams.set('response_type', 'code')
    googleUrl.searchParams.set('scope', GOOGLE_SCOPE)
    googleUrl.searchParams.set('access_type', 'offline')
    googleUrl.searchParams.set('prompt', 'consent')
    googleUrl.searchParams.set('state', state)

    window.location.href = googleUrl.toString()
  }

  async function handleGoogleCallback() {
    const currentUrl = new URL(window.location.href)
    const code = currentUrl.searchParams.get('code')
    const returnedState = currentUrl.searchParams.get('state')
    const savedState = sessionStorage.getItem(STATE_STORAGE_KEY)

    if (!code) {
      throw new Error('Google did not return an authorization code.')
    }

    if (!returnedState || !savedState || returnedState !== savedState) {
      throw new Error('Google login state validation failed.')
    }

    sessionStorage.removeItem(STATE_STORAGE_KEY)

    const response = await fetch(`${API_BASE_URL}/auth/google`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code,
        redirectUri: getCallbackUrl(),
      }),
    })

    const payload = await response.json().catch(() => null)

    if (!response.ok) {
      throw new Error(payload?.message || 'Google sign-in failed.')
    }

    syncCsrfToken(payload?.csrfToken)
    window.history.replaceState({}, document.title, '/')
    await fetchCurrentUser(false)
  }

  async function handleLogout() {
    logoutInFlightRef.current = true
    setError('')
    setBusy(true)

    try {
      const currentCsrfToken = readCookie(CSRF_COOKIE_NAME)

      if (currentCsrfToken) {
        await fetch(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': currentCsrfToken,
          },
          body: JSON.stringify({}),
        })
      }
      } finally {
        setUser(null)
        setCsrfToken(null)
        setAvatarFailed(false)
        setStatus('Logged out')
        setBusy(false)
        logoutInFlightRef.current = false
    }
  }

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        setBusy(true)
        setError('')

        if (window.location.pathname === CALLBACK_PATH) {
          setStatus('Completing Google sign-in...')
          await handleGoogleCallback()
        } else if (readCookie(CSRF_COOKIE_NAME)) {
          await fetchCurrentUser(true)
        } else {
          setStatus('Sign in to continue')
        }
      } catch (bootstrapError) {
        if (!cancelled) {
          clearSession(bootstrapError.message)
          setError(bootstrapError.message)
        }
      } finally {
        if (!cancelled) {
          setBusy(false)
        }
      }
    }

    bootstrap()

    return () => {
      cancelled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10 text-slate-50">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-3xl items-center justify-center">
        <section className="w-full rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-2xl shadow-slate-950/40 backdrop-blur md:p-8">
          <div className="mb-8">
            <p className="text-sm uppercase tracking-[0.28em] text-sky-300">Knitt Auth</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white">
              Get started with Google
            </h1>
            <p className="mt-3 max-w-xl text-sm text-slate-300">
              Sign in once, keep auth in cookies, and automatically log out when the
              session expires or when you choose to leave.
            </p>
          </div>

          {!user ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-slate-900/70 p-5">
              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={busy}
                className="flex w-full items-center justify-center gap-3 rounded-full bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="text-base text-sky-600">G</span>
                {busy ? status : 'Get started with Google'}
              </button>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-[1.4fr_0.8fr]">
              <div className="rounded-[1.5rem] border border-white/10 bg-slate-900/70 p-5">
                <div className="flex items-center gap-4">
                  {user.avatar && !avatarFailed ? (
                    <img
                      src={user.avatar}
                      alt={user.name}
                      referrerPolicy="no-referrer"
                      onError={() => setAvatarFailed(true)}
                      className="h-16 w-16 rounded-full object-cover ring-2 ring-sky-400/30"
                    />
                  ) : (
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-sky-500/20 text-xl font-semibold text-sky-200">
                      {user.name?.slice(0, 1)?.toUpperCase() || 'U'}
                    </div>
                  )}

                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-emerald-300">
                      Signed in
                    </p>
                    <h2 className="mt-1 text-2xl font-semibold text-white">{user.name}</h2>
                    <p className="mt-1 text-sm text-slate-300">{user.email}</p>
                  </div>
                </div>

                <dl className="mt-6 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <dt className="text-xs uppercase tracking-[0.2em] text-slate-400">User ID</dt>
                    <dd className="mt-2 break-all text-sm text-white">{user.id}</dd>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <dt className="text-xs uppercase tracking-[0.2em] text-slate-400">Role</dt>
                    <dd className="mt-2 text-sm text-white">{user.role}</dd>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <dt className="text-xs uppercase tracking-[0.2em] text-slate-400">
                      Email Verified
                    </dt>
                    <dd className="mt-2 text-sm text-white">
                      {user.isEmailVerified ? 'Yes' : 'No'}
                    </dd>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <dt className="text-xs uppercase tracking-[0.2em] text-slate-400">Status</dt>
                    <dd className="mt-2 text-sm text-white">{status}</dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-[1.5rem] border border-white/10 bg-slate-900/70 p-5">
                <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">
                  Cookie Session
                </h3>

                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <dt className="text-slate-300">Access token</dt>
                    <dd className="text-emerald-300">Cookie</dd>
                  </div>
                  <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <dt className="text-slate-300">Refresh token</dt>
                    <dd className="text-emerald-300">Cookie</dd>
                  </div>
                  <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <dt className="text-slate-300">CSRF token</dt>
                    <dd className={csrfToken ? 'text-emerald-300' : 'text-amber-300'}>
                      {csrfToken ? 'Cookie present' : 'Missing'}
                    </dd>
                  </div>
                </dl>

                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={busy}
                  className="mt-6 w-full rounded-full border border-white/15 bg-white/5 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Logout
                </button>
              </div>
            </div>
          )}

          {error ? (
            <p className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  )
}

export default App
