# Frontend: Keep User Logged In After Tab Closes

The backend is already configured to persist login via **refresh token cookie** (7 days). The frontend needs to handle token storage and auto-refresh properly.

## Backend Setup ✅

- **Refresh token**: Stored in httpOnly cookie (7 days) - persists across tab closes
- **Access token**: Short-lived (15 minutes) - stored in frontend
- **Endpoints**:
  - `POST /auth/refresh` - Get new access token using refresh cookie
  - `GET /auth/check` - Check if user is still logged in

## Frontend Implementation

### 1. Store Access Token in localStorage (NOT sessionStorage)

```javascript
// ✅ CORRECT - persists after tab close
localStorage.setItem('access_token', token);

// ❌ WRONG - lost when tab closes
sessionStorage.setItem('access_token', token);
```

### 2. On App Load: Check Login Status

```javascript
// On app initialization (e.g. App.js, index.js, or auth context)
useEffect(() => {
  const checkAuth = async () => {
    // Option A: Check if access token exists and is valid
    const token = localStorage.getItem('access_token');
    if (token) {
      // Verify token is still valid (not expired)
      try {
        const decoded = jwtDecode(token); // or your JWT decode function
        if (decoded.exp * 1000 > Date.now()) {
          // Token still valid, user is logged in
          setUser(decoded);
          return;
        }
      } catch (e) {
        // Token invalid, try refresh
      }
    }

    // Option B: Use /auth/check endpoint (simpler)
    try {
      const response = await fetch('http://localhost:4000/auth/check', {
        credentials: 'include' // IMPORTANT: sends cookies
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.loggedIn) {
          // User is logged in, get new access token
          await refreshAccessToken();
        }
      }
    } catch (error) {
      // Not logged in
      console.log('User not logged in');
    }
  };

  checkAuth();
}, []);
```

### 3. Auto-Refresh Access Token

```javascript
const refreshAccessToken = async () => {
  try {
    const response = await fetch('http://localhost:4000/auth/refresh', {
      method: 'POST',
      credentials: 'include' // IMPORTANT: sends refresh_token cookie
    });

    if (response.ok) {
      const data = await response.json();
      localStorage.setItem('access_token', data.token);
      // Update user state if needed
      return data.token;
    } else {
      // Refresh token expired, logout
      localStorage.removeItem('access_token');
      // Redirect to login
    }
  } catch (error) {
    console.error('Token refresh failed:', error);
    localStorage.removeItem('access_token');
    // Redirect to login
  }
};
```

### 4. Refresh Token Before It Expires

```javascript
// Refresh token every 14 minutes (before 15min expiry)
useEffect(() => {
  const token = localStorage.getItem('access_token');
  if (!token) return;

  // Decode token to get expiry
  const decoded = jwtDecode(token);
  const expiresIn = decoded.exp * 1000 - Date.now();
  const refreshTime = expiresIn - 60000; // Refresh 1 minute before expiry

  const timer = setTimeout(() => {
    refreshAccessToken();
  }, refreshTime);

  return () => clearTimeout(timer);
}, [localStorage.getItem('access_token')]);
```

### 5. Include Credentials in All API Calls

```javascript
// IMPORTANT: Always include credentials to send cookies
fetch('http://localhost:4000/api/leads', {
  headers: {
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`
  },
  credentials: 'include' // 🔥 REQUIRED for cookies
});
```

### 6. Complete Example (React)

```javascript
// AuthContext.js or similar
import { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Configure axios to always send credentials
  axios.defaults.withCredentials = true;

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      // Check if refresh token cookie exists
      const response = await axios.get('http://localhost:4000/auth/check');
      
      if (response.data.loggedIn) {
        // Get new access token
        const tokenResponse = await axios.post('http://localhost:4000/auth/refresh');
        localStorage.setItem('access_token', tokenResponse.data.token);
        setUser(tokenResponse.data.rep);
      }
    } catch (error) {
      // Not logged in
      localStorage.removeItem('access_token');
    } finally {
      setLoading(false);
    }
  };

  const login = async (email, password) => {
    const response = await axios.post('http://localhost:4000/api/admin/login', {
      email,
      password
    });
    
    localStorage.setItem('access_token', response.data.token);
    setUser(response.data.rep);
    // Refresh token cookie is automatically set by backend
  };

  const logout = async () => {
    localStorage.removeItem('access_token');
    setUser(null);
    // Optionally: call logout endpoint to clear cookie
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};
```

## Key Points

1. ✅ **localStorage** for access token (not sessionStorage)
2. ✅ **credentials: 'include'** in all fetch/axios calls
3. ✅ Check login status on app load using `/auth/check`
4. ✅ Auto-refresh access token before expiry
5. ✅ Refresh token cookie persists automatically (7 days)

## Testing

1. Login → Close tab → Reopen → Should still be logged in
2. Login → Close browser → Reopen → Should still be logged in (within 7 days)
3. Wait 15+ minutes → Access token expires → Should auto-refresh
