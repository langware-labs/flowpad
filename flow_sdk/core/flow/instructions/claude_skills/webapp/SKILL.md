---
name: webapp
description: Bootstrap and develop full-stack web applications with React/TypeScript/Tailwind/shadcn frontend and FastAPI backend. Use when creating web apps, setting up project structure, adding components, pages, or API endpoints.
tags:
  - webapp
  - react
  - fastapi
  - fullstack
allowed-tools: Bash, Read, Write, Edit
---

# Web App Development Skill

Build full-stack web applications using:
- **Frontend**: React + TypeScript + Vite + Tailwind CSS + shadcn/ui
- **Backend**: FastAPI + Python + Pydantic

## Project Structure

```
project/
├── frontend/
│   ├── src/
│   │   ├── components/ui/   # shadcn UI components
│   │   ├── lib/utils.ts     # Utility functions (cn helper)
│   │   ├── App.tsx          # Main app component
│   │   ├── main.tsx         # Entry point
│   │   └── index.css        # Tailwind styles
│   ├── vite.config.ts       # Vite config with API proxy
│   └── package.json
└── backend/
    ├── main.py              # FastAPI app with routes
    └── requirements.txt
```

## Port Configuration

| Service  | Port | URL                    |
|----------|------|------------------------|
| Frontend | 3000 | http://localhost:3000  |
| Backend  | 8080 | http://localhost:8080  |

The frontend proxies `/api/*` requests to the backend via Vite config.

## Development Workflow

Determine the task type and follow the appropriate guide:

**Adding a UI component?** → See [ADDING_COMPONENT.md](ADDING_COMPONENT.md)
**Adding a new page/route?** → See [ADDING_PAGE.md](ADDING_PAGE.md)
**Adding a backend endpoint?** → See [ADDING_BACKEND_ENDPOINT.md](ADDING_BACKEND_ENDPOINT.md)

## Quick Reference

### Start Development Servers

**Backend:**
```bash
cd backend && uvicorn main:app --reload --port 8080
```

**Frontend:**
```bash
cd frontend && npm run dev
```

### Frontend API Calls

All API calls use relative `/api/*` paths (proxied to backend):

```typescript
const response = await fetch("/api/endpoint");
const data = await response.json();
```

### Adding shadcn Components

1. Create component in `src/components/ui/`
2. Use `cn` utility from `@/lib/utils` for class merging
3. Follow shadcn patterns from https://ui.shadcn.com/docs/components

## Building for Production

**Frontend:**
```bash
cd frontend && npm run build  # Output in dist/
```

**Backend:**
```bash
cd backend && uvicorn main:app --host 0.0.0.0 --port 8080 --workers 4
```

## IMPORTANT: Notify User When Ready

you MUST report both services to the user using `flow-result` tags with service control attributes.
if you do not do this, the user will not be able to see or interact with the running web application from the FlowPad interface.

### Service Control Attributes

Include these attributes to enable service control from the UI:

| Attribute | Description |
|-----------|-------------|
| `start-cmd` | Command to start/restart the service |
| `health` | Health check endpoint path (relative to port) |
| `port` | Port number the service runs on |

### Required Flow Results

**1. Frontend Web App** (type: `webapp`)
```xml
<flow-result name="Frontend App" port="3000" ref_type="FOLDER" path="frontend" type="webapp" start-cmd="cd frontend && npm run dev" health="/" description="React frontend application" focus="web-app"/>
```

**2. Backend API Service** (type: `app_service`)
```xml
<flow-result name="Backend API" port="8080" path="backend/main.py" type="app_service" start-cmd="cd backend && uvicorn main:app --reload --port 8080" health="/api/health" description="FastAPI backend service"/>
```

### Complete Example

After both servers are running, output:

```
Your web application is ready!

<flow-result name="Web App" port="3000" ref_type="FOLDER" path="frontend" type="webapp" start-cmd="cd frontend && npm run dev" health="/" description="React + Vite frontend with Tailwind CSS" focus="web-app"/>
<flow-result name="API Server" port="8080" path="backend/main.py" type="app_service" start-cmd="cd backend && uvicorn main:app --reload --port 8080" health="/api/health" description="FastAPI backend API"/>

- Frontend: http://localhost:3000
- Backend API: http://localhost:8080
```

This ensures the user can see, interact with, and control both services from the FlowPad interface.
