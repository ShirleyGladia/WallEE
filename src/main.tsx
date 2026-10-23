import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Loop from './pages/Loop'
import Ingest from './pages/Ingest'
import Dataset from './pages/Dataset'
import Select from './pages/Select'
import Train from './pages/Train'
import Evaluate from './pages/Evaluate'
import Serve from './pages/Serve'
import Diagnose from './pages/Diagnose'
import './styles.css'

// HashRouter so the app also works as a single static file (no server routing needed).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="loop" element={<Loop />} />
          <Route path="ingest" element={<Ingest />} />
          <Route path="dataset" element={<Dataset />} />
          <Route path="select" element={<Select />} />
          <Route path="train" element={<Train />} />
          <Route path="evaluate" element={<Evaluate />} />
          <Route path="serve" element={<Serve />} />
          <Route path="diagnose" element={<Diagnose />} />
        </Route>
      </Routes>
    </HashRouter>
  </React.StrictMode>,
)
