# Socket vs Firebase Push Flow

## Rule

- **Rep in `onlineUsers`** (foreground, socket connected) → use **socket** for real-time updates. **No push.**
- **Rep not in `onlineUsers`** (background or disconnected) → use **Firebase** (stored FCM token) to send push.

## Flow

| Event | Backend action | Notifications |
|-------|----------------|----------------|
| **Connection** | Add rep to `onlineUsers`, clear `repInBackground` | Use **socket** |
| **`background`** (tab minimized/hidden) | Remove from `onlineUsers`, add to `repInBackground` | Use **Firebase** (socket still connected) |
| **`foreground`** (tab visible again) | Add to `onlineUsers`, remove from `repInBackground` | Use **socket** again |
| **`disconnect`** (tab/browser closed) | Remove from `onlineUsers` and `repInBackground` | Use **Firebase** |

## Sequence

1. **Minimize** → frontend emits `background` → backend marks rep as “in background” → new messages trigger **Firebase push**.
2. **Socket disconnects** (e.g. after background, or tab closed) → backend removes rep from `onlineUsers` → new messages trigger **Firebase push** (using stored FCM token).
3. **Restore tab** (or new connection) → frontend emits `foreground` or socket connects → backend adds rep to `onlineUsers` → **socket** used again for real-time updates.

## State (see `socket/repState.js`)

- **`onlineUsers`**: `repId → socket` — rep is in foreground and connected; use socket.
- **`repInBackground`**: `Set` of `repId` — rep is connected but tab in background; use Firebase for push (and log “in background” vs “disconnected”).

## Frontend

- On **visibility change**: if `document.visibilityState === 'hidden'` → `socket.emit('background')`; else → `socket.emit('foreground')`.
- See `FRONTEND_SOCKET_VISIBILITY.md` for code.
