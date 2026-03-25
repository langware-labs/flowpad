# Adding a New Page

Guide for adding new pages and routes to the frontend.

## Prerequisites

Install react-router-dom if not already present:

```bash
cd frontend && npm install react-router-dom
```

## Step 1: Create the Page Component

Create a new file in `src/pages/`:

```
frontend/src/
├── pages/
│   ├── home.tsx        # Home page
│   ├── dashboard.tsx   # Dashboard page
│   └── settings.tsx    # Settings page
└── App.tsx
```

### Page Template

```typescript
// src/pages/dashboard.tsx
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface DashboardData {
  stats: { label: string; value: number }[];
}

function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((res) => res.json())
      .then(setData)
      .catch(console.error);
  }, []);

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Dashboard</h1>
      <div className="grid grid-cols-3 gap-4">
        {data?.stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader>
              <CardTitle>{stat.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default DashboardPage;
```

## Step 2: Configure the Router

Update `App.tsx` to include routing:

```typescript
// src/App.tsx
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import HomePage from "./pages/home";
import DashboardPage from "./pages/dashboard";
import SettingsPage from "./pages/settings";

function App() {
  return (
    <BrowserRouter>
      <nav className="border-b p-4">
        <div className="container mx-auto flex gap-4">
          <Link to="/" className="hover:underline">Home</Link>
          <Link to="/dashboard" className="hover:underline">Dashboard</Link>
          <Link to="/settings" className="hover:underline">Settings</Link>
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
```

## Step 3: Update Entry Point (if needed)

Ensure `main.tsx` wraps the app correctly:

```typescript
// src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

## Dynamic Routes

For pages with URL parameters:

```typescript
// src/pages/user-detail.tsx
import { useParams } from "react-router-dom";

function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>();

  // Fetch user data using userId
  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then((res) => res.json())
      .then(setUser);
  }, [userId]);

  return <div>User: {userId}</div>;
}
```

Register in router:

```typescript
<Route path="/users/:userId" element={<UserDetailPage />} />
```

## Workflow Checklist

Copy and track progress:

```
Adding Page:
- [ ] Create page component in src/pages/
- [ ] Define TypeScript interfaces for page data
- [ ] Add API fetch logic for page data
- [ ] Import page in App.tsx
- [ ] Add Route entry in Routes component
- [ ] Add navigation Link (if needed)
- [ ] Test page renders at correct URL
```

## Navigation Patterns

### Programmatic Navigation

```typescript
import { useNavigate } from "react-router-dom";

function MyComponent() {
  const navigate = useNavigate();

  const handleClick = () => {
    navigate("/dashboard");
    // Or with state: navigate("/dashboard", { state: { from: "home" } });
  };

  return <button onClick={handleClick}>Go to Dashboard</button>;
}
```

### Protected Routes (Basic Pattern)

```typescript
import { Navigate } from "react-router-dom";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = /* check auth state */;

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

// Usage in App.tsx
<Route
  path="/dashboard"
  element={
    <ProtectedRoute>
      <DashboardPage />
    </ProtectedRoute>
  }
/>
```
