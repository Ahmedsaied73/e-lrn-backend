import {create} from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: number;
  name: string;
  email: string;
  role: string;
}

interface AuthState {
  token: string | null;
  user: User | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  login: (token: string, userData: User) => void;
  logout: () => void;
  setToken: (token: string | null) => void;
  setUser: (userData: User | null) => void;
}

const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      isAuthenticated: false,
      isAdmin: false,
      login: (token, userData) => {
        set({
          token,
          user: userData,
          isAuthenticated: true,
          isAdmin: userData.role === 'ADMIN'
        });
      },
      logout: () => {
        set({
          token: null,
          user: null,
          isAuthenticated: false,
          isAdmin: false
        });
      },
      setToken: (token) => set({ token, isAuthenticated: !!token }),
      setUser: (userData) => set({
        user: userData,
        isAdmin: userData?.role === 'ADMIN'
      }),
    }),
    {
      name: 'auth-storage', // name of the item in storage (must be unique)
      // getStorage: () => sessionStorage, // (optional) by default, 'localStorage' is used
    }
  )
);

export default useAuthStore;
