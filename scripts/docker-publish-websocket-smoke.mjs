import http from 'http'
import crypto from 'crypto'

const expectedCode = 1008
const timeoutMs = 5000
let done = false
let upgraded = false
let request = null
let socket = null
let buffer = Buffer.alloc(0)

const finish = (ok, message) => {
  if (done) return
  done = true
  clearTimeout(timer)
  if (request) request.destroy()
  if (socket) socket.destroy()
  if (ok) {
    console.log('WebSocket smoke probe passed: upgrade status=101 and close code=1008.')
    process.exit(0)
  }
  console.error(`WebSocket smoke probe failed: ${message}`)
  process.exit(1)
}

const consume = (chunk) => {
  if (done) return
  if (chunk && chunk.length > 0) buffer = Buffer.concat([buffer, chunk])
  if (buffer.length < 2) return

  const opcode = buffer[0] & 0x0f
  if (opcode !== 0x8) return finish(false, `expected first WebSocket frame opcode 0x8 (close) but got 0x${opcode.toString(16)}`)

  const b1 = buffer[1]
  const payloadLength = b1 & 0x7f
  if ((b1 & 0x80) !== 0) return finish(false, 'unexpected masked server close frame')
  if (payloadLength > 125) return finish(false, `close frame payload length ${payloadLength} is invalid for a control frame`)
  if (buffer.length < 2 + payloadLength) return
  if (payloadLength < 2) return finish(false, 'close frame missing close code payload')

  const closeCode = buffer.readUInt16BE(2)
  if (closeCode !== expectedCode) return finish(false, `expected close code ${expectedCode} but got ${closeCode}`)
  finish(true)
}

const timer = setTimeout(() => {
  if (!upgraded) return finish(false, `timed out after ${timeoutMs}ms waiting for HTTP 101 upgrade`)
  finish(false, `timed out after ${timeoutMs}ms waiting for WebSocket close frame with code ${expectedCode}`)
}, timeoutMs)

request = http.request('http://127.0.0.1:4000/', {
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
  },
})

request.on('response', (res) => {
  finish(false, `expected HTTP 101 upgrade but got HTTP ${res.statusCode ?? 'unknown'}`)
})

request.on('upgrade', (res, upgradedSocket, head) => {
  if (res.statusCode !== 101) {
    finish(false, `expected HTTP 101 upgrade but got HTTP ${res.statusCode ?? 'unknown'}`)
    return
  }
  upgraded = true

  socket = upgradedSocket
  socket.on('data', consume)
  socket.on('end', () => {
    finish(false, 'connection ended before receiving the expected WebSocket close frame')
  })
  socket.on('close', () => {
    finish(false, 'connection closed before receiving the expected WebSocket close frame')
  })
  socket.on('error', (error) => {
    finish(false, `connection/upgrade failed: ${error.message}`)
  })

  consume(head)
})

request.on('error', (error) => {
  finish(false, `connection/upgrade failed: ${error.message}`)
})

request.end()
