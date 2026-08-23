import React, { createContext, useState, useContext, useEffect } from 'react'
import { authApi } from '@/api/auth'

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
    const token = localStorage.getItem('access_token')
    if (token) {
      try {
        const currentUser = await authApi.me()
        setUser(currentUser)
        setIsAuthenticated(true)
      } catch (e) {
        localStorage.removeItem('access_token')
        localStorage.removeItem('refresh_token')
      }
    }
    setIsLoadingAuth(false)
    setAuthChecked(true)
  }

  const login = async (email, password) => {
    const data = await authApi.login(email, password)
    localStorage.setItem('access_token', data.accessToken)
    localStorage.setItem('refresh_token', data.refreshToken)
    setUser(data.user)
    setIsAuthenticated(true)
    setAuthError(null)
    return data
  }

  const register = async (email, password, name) => {
    const data = await authApi.register(email, password, name)
    localStorage.setItem('access_token', data.accessToken)
    localStorage.setItem('refresh_token', data.refreshToken)
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
    localStorage.removeItem('access_token')
    localStorage.removeItem('refresh_token')
    setUser(null)
    setIsAuthenticated(false)
  }

  const navigateToLogin = () => {
    window.location.href = '/login'
  }

  const refreshAuth = async () => {
    const token = localStorage.getItem('access_token')
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
