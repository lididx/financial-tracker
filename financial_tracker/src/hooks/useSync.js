import { useState, useEffect, useCallback, useRef } from 'react'

const CLIENT_ID = Math.random().toString(36).slice(2)

export function useSync(migrateData, INIT) {
  const [data, setDataRaw] = useState(null)
  const [theme, setThemeRaw] = useState(() => {
    try { return localStorage.getItem('fin-theme') || 'light' } catch { return 'light' }
  })
  const [syncStatus, setSyncStatus] = useState('loading')

  const revisionRef = useRef(0)
  const saveTimerRef = useRef(null)
  const abortRef = useRef(null)
  const dataRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('./api/data', {
          headers: { 'X-Client-Id': CLIENT_ID },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        if (json.data) {
          const migrated = migrateData(json.data)
          setDataRaw(migrated)
          dataRef.current = migrated
          setThemeRaw(json.theme || 'light')
          revisionRef.current = json.revision || 0
          setSyncStatus('saved')
        } else {
          const local = localStorage.getItem('fin-v2')
          if (local) {
            const parsed = migrateData(JSON.parse(local))
            setDataRaw(parsed)
            dataRef.current = parsed
            setSyncStatus('migrate')
          } else {
            setDataRaw(INIT)
            dataRef.current = INIT
            setSyncStatus('saved')
          }
        }
      } catch {
        try {
          const local = localStorage.getItem('fin-v2')
          if (local) {
            const parsed = migrateData(JSON.parse(local))
            setDataRaw(parsed)
            dataRef.current = parsed
          } else {
            setDataRaw(INIT)
            dataRef.current = INIT
          }
        } catch {
          setDataRaw(INIT)
          dataRef.current = INIT
        }
        setSyncStatus('offline')
      }
    })()
    return () => { cancelled = true }
  }, [])

  const [sseReady, setSseReady] = useState(false)
  useEffect(() => {
    if (!dataRef.current) return
    setSseReady(true)
  }, [data !== null])

  useEffect(() => {
    if (!sseReady) return
    const es = new EventSource(`./api/events?clientId=${CLIENT_ID}`)

    es.addEventListener('update', (e) => {
      try {
        const payload = JSON.parse(e.data)
        const migrated = migrateData(payload.data)
        setDataRaw(migrated)
        dataRef.current = migrated
        if (payload.theme) setThemeRaw(payload.theme)
        revisionRef.current = payload.revision
        try {
          localStorage.setItem('fin-v2', JSON.stringify(migrated))
          if (payload.theme) localStorage.setItem('fin-theme', payload.theme)
        } catch {}
        setSyncStatus('saved')
      } catch {}
    })

    es.addEventListener('connected', (e) => {
      try {
        const { revision } = JSON.parse(e.data)
        if (revision > revisionRef.current) {
          fetch('./api/data', { headers: { 'X-Client-Id': CLIENT_ID } })
            .then(r => r.json())
            .then(json => {
              if (json.data) {
                const migrated = migrateData(json.data)
                setDataRaw(migrated)
                dataRef.current = migrated
                revisionRef.current = json.revision
                if (json.theme) setThemeRaw(json.theme)
              }
            })
            .catch(() => {})
        }
        setSyncStatus(prev => prev === 'saving' ? prev : 'saved')
      } catch {}
    })

    es.onerror = () => {
      setSyncStatus(prev => prev === 'saving' ? prev : 'offline')
    }
    es.onopen = () => {
      setSyncStatus(prev => prev === 'saving' ? prev : 'saved')
    }

    return () => es.close()
  }, [sseReady])

  const saveToServer = useCallback((newData, newTheme) => {
    try {
      localStorage.setItem('fin-v2', JSON.stringify(newData))
      if (newTheme !== undefined) localStorage.setItem('fin-theme', newTheme)
    } catch {}

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (abortRef.current) abortRef.current.abort()

    setSyncStatus('saving')

    saveTimerRef.current = setTimeout(async () => {
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const res = await fetch('./api/data', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Id': CLIENT_ID,
          },
          body: JSON.stringify({
            data: newData,
            theme: newTheme !== undefined ? newTheme : theme,
            revision: revisionRef.current,
          }),
          signal: controller.signal,
        })
        if (res.status === 409) {
          const conflict = await res.json()
          const serverMigrated = migrateData(conflict.serverData)
          setDataRaw(serverMigrated)
          dataRef.current = serverMigrated
          revisionRef.current = conflict.serverRevision
          if (conflict.serverTheme) setThemeRaw(conflict.serverTheme)
          setSyncStatus('conflict')
          setTimeout(() => setSyncStatus('saved'), 3000)
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const result = await res.json()
        revisionRef.current = result.revision
        setSyncStatus('saved')
      } catch (err) {
        if (err.name === 'AbortError') return
        setSyncStatus('offline')
      }
    }, 800)
  }, [theme])

  const setData = useCallback((updater) => {
    setDataRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      dataRef.current = next
      saveToServer(next, undefined)
      return next
    })
  }, [saveToServer])

  const setTheme = useCallback((newTheme) => {
    setThemeRaw(newTheme)
    if (dataRef.current) saveToServer(dataRef.current, newTheme)
  }, [saveToServer])

  const uploadLocalData = useCallback(async (localData) => {
    try {
      const res = await fetch('./api/data', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': CLIENT_ID,
        },
        body: JSON.stringify({
          data: localData,
          theme: localStorage.getItem('fin-theme') || 'light',
          revision: 0,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      revisionRef.current = result.revision
      setSyncStatus('saved')
    } catch {
      setSyncStatus('offline')
    }
  }, [])

  return { data, setData, theme, setTheme, syncStatus, setSyncStatus, uploadLocalData }
}
