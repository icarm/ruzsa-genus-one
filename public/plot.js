// Client-side rendering of the homepage records scatter. The page ships only
// the static SVG frame (axes, grid, guide lines); this script fetches
// /records.json — one [witnessId, n, size] triple per modulus — and draws the
// dots onto a canvas overlay, with hover tooltips and click-through to the
// witness pages. With 30k+ moduli, server-rendered SVG dots made the page
// multiple megabytes and ~100k DOM nodes; the canvas keeps both tiny.
//
// The geometry here mirrors the server-side frame in src/pages.ts (PLOT,
// plotX, sizePlot, exponentPlot) — keep the two in sync.
(function () {
  'use strict'

  var stage = document.querySelector('.plot-stage')
  if (!stage) return
  var view = stage.dataset.plot // 'exponent' | 'size'
  var canvas = stage.querySelector('.plot-canvas')
  var tooltip = stage.querySelector('.plot-tooltip')
  var loading = stage.querySelector('.plot-loading')
  var refresh = document.querySelector('.plot-refresh')
  var ctx = canvas.getContext('2d')
  // Revealed only from JS so users without it never see a stuck indicator;
  // removed (or turned into an error note) when the fetch settles.
  if (loading) loading.hidden = false

  var W = 720, H = 440, L = 56, R = 18, T = 18, B = 46
  var IW = W - L - R, IH = H - T - B
  var LOG_NMIN = Math.log10(2)
  var LOG_NMAX = Math.log10(50000) // MAX_N in src/verify.ts
  var EXP_MIN = 0.35, EXP_MAX = 0.5 // exponent view y-window

  var rootStyle = getComputedStyle(document.documentElement)
  function cssColor(name, fallback) {
    var v = rootStyle.getPropertyValue(name).trim()
    return v || fallback
  }
  var DOT = cssColor('--accent', '#fbbf24')
  var BEATS = cssColor('--valid', '#34d399')
  var BEATS_EDGE = cssColor('--fg', '#e9e5f2')
  var HOVER = '#ffd267'

  var pts = [] // projected dots, sqrt-beating ones last so they draw on top
  var hover = null

  function project(records) {
    pts = []
    for (var i = 0; i < records.length; i++) {
      var id = records[i][0], n = records[i][1], size = records[i][2]
      var exponent = Math.log(size) / Math.log(n)
      var y
      if (view === 'exponent') {
        if (exponent < EXP_MIN) continue // below the window, cut off
        y = T + IH - ((exponent - EXP_MIN) / (EXP_MAX - EXP_MIN)) * IH
      } else {
        y = T + IH - (Math.log10(size) / (LOG_NMAX / 2)) * IH
      }
      pts.push({
        id: id,
        n: n,
        size: size,
        exponent: exponent,
        beats: size * size > n,
        x: L + ((Math.log10(n) - LOG_NMIN) / (LOG_NMAX - LOG_NMIN)) * IW,
        y: y,
      })
    }
    pts.sort(function (a, b) { return (a.beats ? 1 : 0) - (b.beats ? 1 : 0) })
  }

  function draw() {
    var scale = (canvas.clientWidth / W) * (window.devicePixelRatio || 1)
    var pw = Math.round(W * scale), ph = Math.round(H * scale)
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw
      canvas.height = ph
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.lineWidth = 1
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i]
      var isHover = p === hover
      ctx.beginPath()
      ctx.arc(p.x, p.y, isHover ? 5 : p.beats ? 4.5 : 3, 0, 2 * Math.PI)
      ctx.fillStyle = isHover ? HOVER : p.beats ? BEATS : DOT
      ctx.fill()
      if (p.beats) {
        ctx.strokeStyle = BEATS_EDGE
        ctx.stroke()
      }
    }
  }

  // Nearest dot within 10 frame-pixels of a pointer event, or null.
  function hit(e) {
    var rect = canvas.getBoundingClientRect()
    var mx = ((e.clientX - rect.left) / rect.width) * W
    var my = ((e.clientY - rect.top) / rect.height) * H
    var best = null, bestD = 10 * 10
    for (var i = 0; i < pts.length; i++) {
      var dx = pts[i].x - mx, dy = pts[i].y - my
      var d = dx * dx + dy * dy
      if (d < bestD) {
        best = pts[i]
        bestD = d
      }
    }
    return best
  }

  function setHover(p) {
    if (p === hover) return
    hover = p
    draw()
    canvas.style.cursor = p ? 'pointer' : ''
    if (p) {
      tooltip.textContent =
        'N = ' + p.n.toLocaleString('en-US') +
        ': record |A| = ' + p.size.toLocaleString('en-US') +
        ' (exponent ' + p.exponent.toFixed(4) + ')'
      tooltip.hidden = false
      // Anchor beside the dot, flipping across it near the right edge.
      var rect = canvas.getBoundingClientRect()
      var px = (p.x / W) * rect.width, py = (p.y / H) * rect.height
      var flip = px > rect.width - tooltip.offsetWidth - 16
      tooltip.style.left = (flip ? px - tooltip.offsetWidth - 10 : px + 10) + 'px'
      tooltip.style.top = Math.max(0, py - tooltip.offsetHeight - 6) + 'px'
    } else {
      tooltip.hidden = true
    }
  }

  canvas.addEventListener('pointermove', function (e) { setHover(hit(e)) })
  canvas.addEventListener('pointerleave', function () { setHover(null) })
  canvas.addEventListener('click', function (e) {
    var p = hit(e) // hit-test the click itself so taps work without hover
    if (p) window.location.href = '/witness/' + p.id
  })

  var observing = false
  function load(initial) {
    if (!initial && refresh) {
      refresh.disabled = true
      refresh.textContent = 'refreshing\u2026'
    }
    fetch('/records.json')
      .then(function (res) {
        if (!res.ok) throw new Error('records.json returned ' + res.status)
        return res.json()
      })
      .then(function (records) {
        if (loading) loading.remove()
        if (refresh) {
          refresh.disabled = false
          refresh.textContent = 'refresh'
          refresh.hidden = false // JS-only affordance: reveal once it works
        }
        setHover(null)
        if (initial && records.length === 0) {
          var msg = document.createElement('p')
          msg.className = 'muted'
          msg.textContent =
            'No record witnesses yet — submit a valid set to put the first dot on the board.'
          stage.parentNode.insertBefore(msg, stage)
          return
        }
        project(records)
        draw()
        if (window.ResizeObserver && !observing) {
          observing = true
          new ResizeObserver(draw).observe(canvas)
        }
      })
      .catch(function (err) {
        console.error('failed to load records:', err)
        if (initial && loading) {
          loading.hidden = false
          loading.textContent = 'failed to load the records — reload to retry'
          loading.classList.add('failed')
        }
        if (!initial && refresh) {
          refresh.disabled = false
          refresh.textContent = 'refresh failed \u2014 retry'
        }
      })
  }

  if (refresh) refresh.addEventListener('click', function () { load(false) })
  load(true)
})()
