---
title: "Plan: Daily Date & Time Greeting on Flowpad Open"
spec_type: plan
spec_id: a1fe4df5-efc9-423e-aba5-da76bd40d611
author_id: c744dde5-fa8e-480c-9020-286205ec6cf4
plan_id: Users/Gadi/.claude/plans/cuddly-finding-treasure.md
---

# Plan: Daily Date & Time Greeting on Flowpad Open

## Context

The user wants to see the current date and time displayed once per day whenever they open Flowpad. This is a lightweight "good morning" style notification — show it once the first time the app loads each day, then suppress it for the rest of that day.

## Approach

Add a `useEffect` in `AppContent` (`ui/src/App.tsx`) that fires on mount, checks `localStorage` to see if the greeting was already shown today, and if not, fires a Sonner toast with the formatted date and time and stores today's date key.

No backend changes needed — this is entirely frontend.

## Implementation

### File: `ui/src/App.tsx`

1. Add `import { toast } from 'sonner';` at the top (Sonner is already rendered in `AppContent`).

2. In `AppContent`, add this `useEffect` after the existing `initNotificationListener` effect:

```tsx
// Show daily date/time greeting once per day
useEffect(() => {
  const todayKey = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const lastShown = localStorage.getItem('daily-greeting-date');
  if (lastShown !== todayKey) {
    const now = new Date();
    const formatted = now.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const time = now.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    toast(`${formatted} — ${time}`, { duration: 6000 });
    localStorage.setItem('daily-greeting-date', todayKey);
  }
}, []);
```

## Critical File

* `ui/src/App.tsx` — only file that needs to change

## Verification

1. Open Flowpad — a Sonner toast should appear at the bottom with today's date and time (e.g., "Sunday, April 6, 2026 — 09:15 AM").
2. Refresh or reopen the app the same day — toast should NOT appear again.
3. Clear `localStorage` key `daily-greeting-date` in DevTools → reload → toast appears again.