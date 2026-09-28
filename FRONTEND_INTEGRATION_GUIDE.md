# 🚀 Frontend Integration & Setup Guide (Next.js / React)

> **Target Audience**: Frontend Engineering Team  
> **Objective**: Integrate with the updated Express backend using HttpOnly Cookie Authentication and resolve `TypeError: Failed to fetch` CORS errors.

---

## 📋 Executive Summary of Backend Changes

The backend has been updated to support **Dual HttpOnly Cookie Authentication** and **Dynamic CORS Credentials**:
1. **No `localStorage` Tokens**: Access & Refresh tokens are issued automatically by the server as `HttpOnly`, `Secure` cookies.
2. **Dual-Mode Response**: For backward compatibility, token payloads are still included in the JSON response, but browsers will handle session state automatically via cookies.
3. **CORS credentials**: Requests made with `credentials: 'include'` (or `withCredentials: true`) will now succeed without CORS errors.

---

## ⚙️ Step 1: Frontend Environment Setup

In your Next.js project root, ensure your `.env.local` file contains the backend API base URL:

```env
NEXT_PUBLIC_API_URL="http://localhost:3005"
```

---

## 🛠️ Step 2: HTTP Client Setup (`lib/api-client.ts` or `src/utils/api.js`)

Create or update your central HTTP client instance. You **MUST** set `withCredentials: true` (Axios) or `credentials: 'include'` (Fetch) so browsers send and receive HttpOnly cookies.

### Option A: Axios Implementation (Recommended)

Create `lib/api-client.ts`:

```typescript
import axios from 'axios';

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3005',
  withCredentials: true, // ⚠️ MANDATORY: Enables HttpOnly Cookie transmission
  headers: {
    'Content-Type': 'application/json',
  },
});

// Automatic Silent Token Refresh Interceptor
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Handle 401 Unauthorized errors by attempting a silent token refresh
    if (
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !originalRequest.url?.includes('/auth/refresh-token')
    ) {
      originalRequest._retry = true;
      try {
        // Request a new access token (refreshToken cookie is automatically attached)
        await api.post('/auth/refresh-token');
        // Retry the original request
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh token expired or revoked -> redirect to login page
        if (typeof window !== 'undefined') {
          window.location.href = '/login';
        }
        return Promise.reject(refreshError);
      }
    }
    return Promise.reject(error);
  }
);
```

---

### Option B: Native `fetch()` Wrapper

If you are using native `fetch()` instead of Axios:

```typescript
const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3005';

export async function apiFetch(endpoint: string, options: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    credentials: 'include', // ⚠️ MANDATORY: Enables HttpOnly Cookie transmission
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // Handle 401 Unauthorized (Silent Refresh)
  if (res.status === 401 && !endpoint.includes('/auth/refresh-token')) {
    const refreshRes = await fetch(`${BASE_URL}/auth/refresh-token`, {
      method: 'POST',
      credentials: 'include',
    });

    if (refreshRes.ok) {
      // Retry original request
      return fetch(`${BASE_URL}${endpoint}`, {
        ...options,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
    } else {
      if (typeof window !== 'undefined') window.location.href = '/login';
    }
  }

  return res;
}
```

---

## 🔐 Step 3: Auth Context & User State Provider

Create `context/AuthContext.tsx` to handle authentication state across the application:

```tsx
'use client';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '@/lib/api-client';

interface User {
  id: number;
  name: string;
  email: string;
  role: 'STUDENT' | 'ADMIN';
  phoneNumber?: string;
  grade?: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (credentials: Record<string, any>) => Promise<void>;
  register: (userData: Record<string, any>) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Re-hydrate user profile on mount
  useEffect(() => {
    async function checkAuth() {
      try {
        const { data } = await api.get('/user/me');
        if (data.success) setUser(data.data);
      } catch (err) {
        setUser(null);
      } finally {
        setLoading(false);
      }
    }
    checkAuth();
  }, []);

  const login = async (credentials: Record<string, any>) => {
    const { data } = await api.post('/auth/login', credentials);
    if (data.success) {
      setUser(data.data.user);
    }
  };

  const register = async (userData: Record<string, any>) => {
    const { data } = await api.post('/auth/register', userData);
    if (data.success) {
      setUser(data.data.user);
    }
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setUser(null);
      window.location.href = '/login';
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
```

---

## 🧹 Step 4: Migration Checklist for Frontend Developers

- [ ] **Remove `localStorage.setItem('token', ...)`**: Do NOT save access tokens or refresh tokens in `localStorage` or `sessionStorage`.
- [ ] **Remove `Authorization: Bearer` manual headers**: The browser handles sending `accessToken` in cookies automatically.
- [ ] **Update Axios / Fetch config**: Add `withCredentials: true` (or `credentials: 'include'`) to all global HTTP clients.
- [ ] **Update Logout Flow**: Always trigger `api.post('/auth/logout')` so the backend can clear HttpOnly cookies and invalidate tokens server-side.

---

## ❓ Frequently Asked Questions & Troubleshooting

| Issue | Cause | Solution |
| :--- | :--- | :--- |
| **`TypeError: Failed to fetch`** | Missing `withCredentials: true` or mismatched origin. | Ensure `withCredentials: true` is enabled and frontend runs on `http://localhost:3000`. |
| **Cookies not showing in `Application > Cookies`** | `HttpOnly` cookies are hidden from JavaScript `document.cookie`. | Look under Browser DevTools -> `Network` tab -> Click response -> Check `Set-Cookie` headers. |
| **401 Unauthorized on page refresh** | Access token cookie expired. | The Axios interceptor will automatically call `/auth/refresh-token` to issue a new access cookie silently. |
