import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'

export const authMiddleware = createMiddleware(async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')

  if (!token) {
    throw new HTTPException(401, { message: 'Missing Authorization header' })
  }

  const expected = c.get('palace').apiToken
  if (expected && token !== expected) {
    throw new HTTPException(403, { message: 'Invalid token' })
  }

  await next()
})
