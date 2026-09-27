import React, { createContext, useState, useContext, useEffect } from 'react'
import { authApi } from '@/api/auth'
import { getAccessToken, setAccessToken, clearAccessToken } from './tokenStore'
import { refreshSession } from '../api/client'

const AuthContext = createContext()

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoadingAuth, setIsLoadingAuth] = useState(true)
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true)
  const [authError, setAuthError] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)

  useEffect(() => {
    init()
  }, [])

  const init = async () => {
    setIsLoadingPublicSettings(false)
    if (getAccessToken()) {
      try {
        const currentUser = await authApi.me()
        setUser(currentUser)
        setIsAuthenticated(true)
      } catch (e) {
        clearAccessToken()
      }
    } else {
      // Reload trang: access token mất (memory-only) → silent refresh bằng
      // HttpOnly cookie. Không có cookie → khách vãng lai, im lặng.
      try {
        const data = await refreshSession()
        setUser(data.user)
        setIsAuthenticated(true)
      } catch (e) { /* anonymous */ }
    }
    setIsLoadingAuth(false)
    setAuthChecked(true)
  }

  const login = async (email, password) => {
    const data = await authApi.login(email, password)
    setAccessToken(data.accessToken)
    setUser(data.user)
    setIsAuthenticated(true)
    setAuthError(null)
    return data
  }

  const register = async (email, password, name) => {
    const data = await authApi.register(email, password, name)
    setAccessToken(data.accessToken)
    setUser(data.user)
    setIsAuthenticated(true)
    setAuthError(null)
    return data
  }

  const logout = async () => {
    try {
      await authApi.logout()
    } catch (e) {
      /* ignore */
    }
    clearAccessToken()
    setUser(null)
    setIsAuthenticated(false)
  }

  const navigateToLogin = () => {
    window.location.href = '/login'
  }

  const refreshAuth = async () => {
    const token = getAccessToken()
    if (token) {
      try {
        const currentUser = await authApi.me()
        setUser(currentUser)
        setIsAuthenticated(true)
      } catch (e) {
        setUser(null)
        setIsAuthenticated(false)
      }
    } else {
      setUser(null)
      setIsAuthenticated(false)
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        isLoadingAuth,
        isLoadingPublicSettings,
        authError,
        authChecked,
        login,
        register,
        logout,
        navigateToLogin,
        refreshAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
