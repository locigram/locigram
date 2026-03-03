import { Hono } from 'hono'

export const healthRoute = new Hono()

healthRoute.get('/', (c) => {
  const palace = c.get('palace')
  return c.json({
    status: 'ok',
    palace: { id: palace.id, name: palace.name },
    timestamp: new Date().toISOString(),
  })
})
