import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter' // self-hosted Inter (offline-safe; no CDN/FOUT)
import './index.css'
import '@tabler/icons-webfont/dist/tabler-icons.css' // enables <i className="ti ti-check" />
import App from './App.jsx'
import { SocketProvider } from './SocketContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <SocketProvider>
      <App />
    </SocketProvider>
  </StrictMode>,
)
