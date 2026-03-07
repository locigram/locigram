import { describe, test, expect } from 'bun:test'
import { applyLengthNormalization, applyTimeDecay, applyMMRDiversity, type ScoredResult } from '../../scoring'
import { isNoise } from '@locigram/pipeline/src/noise-filter'

function makeResult(overrides: Partial<ScoredResult> & { id: string }): ScoredResult {
  return {
    text: 'some default text for testing purposes',
    createdAt: new Date(),
    _score: 0.9,
    ...overrides,
  }
}

describe('applyLengthNormalization', () => {
  test('short text gets boosted', () => {
    // Text shorter than anchor (300 chars < 500 anchor) gets a slight boost
    const results = [makeResult({ id: '1', text: 'x'.repeat(300), _score: 0.8 })]
    const scored = applyLengthNormalization(results, 500)
    expect(scored[0]._score).toBeGreaterThan(0.8)
  })

  test('long text gets penalized', () => {
    const results = [makeResult({ id: '1', text: 'word '.repeat(500), _score: 0.8 })]
    const scored = applyLengthNormalization(results, 500)
    expect(scored[0]._score).toBeLessThan(0.8)
  })

  test('disabled when anchor=0', () => {
    const results = [makeResult({ id: '1', text: 'short', _score: 0.8 })]
    const scored = applyLengthNormalization(results, 0)
    expect(scored[0]._score).toBe(0.8)
  })
})

describe('applyTimeDecay', () => {
  test('recent entry keeps ~1.0 factor', () => {
    const results = [makeResult({ id: '1', createdAt: new Date(), _score: 0.9 })]
    const scored = applyTimeDecay(results, 60)
    // Factor should be close to 1.0 for just-created
    expect(scored[0]._score).toBeGreaterThan(0.85)
  })

  test('old entry approaches 0.5 factor', () => {
    const old = new Date()
    old.setFullYear(old.getFullYear() - 2)
    const results = [makeResult({ id: '1', createdAt: old, _score: 1.0 })]
    const scored = applyTimeDecay(results, 60)
    // After ~730 days with halfLife=60, factor should be near 0.5
    expect(scored[0]._score).toBeGreaterThanOrEqual(0.5)
    expect(scored[0]._score).toBeLessThan(0.55)
  })

  test('disabled when halfLife=0', () => {
    const results = [makeResult({ id: '1', _score: 0.9 })]
    const scored = applyTimeDecay(results, 0)
    expect(scored[0]._score).toBe(0.9)
  })
})

describe('applyMMRDiversity', () => {
  test('near-duplicate texts get demoted', () => {
    const text = 'the quick brown fox jumps over the lazy dog near the river bank'
    const results = [
      makeResult({ id: '1', text, _score: 0.9 }),
      makeResult({ id: '2', text, _score: 0.85 }),
    ]
    const scored = applyMMRDiversity(results, 0.85, 0.5)
    // Second duplicate should be penalized
    const second = scored.find(r => r.id === '2')!
    expect(second._score).toBeLessThan(0.85)
  })

  test('diverse texts unchanged', () => {
    const results = [
      makeResult({ id: '1', text: 'the server configuration requires updated firmware for all network devices', _score: 0.9 }),
      makeResult({ id: '2', text: 'annual budget review meeting scheduled with the finance team next tuesday', _score: 0.85 }),
    ]
    const scored = applyMMRDiversity(results, 0.85, 0.5)
    expect(scored.find(r => r.id === '1')!._score).toBe(0.9)
    expect(scored.find(r => r.id === '2')!._score).toBe(0.85)
  })
})

describe('isNoise', () => {
  test('catches agent denials', () => {
    expect(isNoise("I don't have any information about that")).toBe(true)
    expect(isNoise("I don't have any memory of that")).toBe(true)
    expect(isNoise("I don't have any data on this topic")).toBe(true)
  })

  test('catches meta-questions', () => {
    expect(isNoise('do you remember what I said?')).toBe(true)
    expect(isNoise('can you recall the meeting?')).toBe(true)
    expect(isNoise('did I tell you about the project?')).toBe(true)
  })

  test('catches boilerplate', () => {
    expect(isNoise('hi there')).toBe(true)
    expect(isNoise('Hello!')).toBe(true)
    expect(isNoise('good morning')).toBe(true)
    expect(isNoise('HEARTBEAT')).toBe(true)
    expect(isNoise('fresh session starting')).toBe(true)
  })

  test('catches short text', () => {
    expect(isNoise('hi')).toBe(true)
    expect(isNoise('ok')).toBe(true)
    expect(isNoise('')).toBe(true)
  })

  test('real content passes', () => {
    expect(isNoise('The server at 192.168.1.1 was upgraded to firmware v2.3.4')).toBe(false)
    expect(isNoise('John mentioned the contract renewal is due in March')).toBe(false)
    expect(isNoise('Meeting notes from the architecture review session')).toBe(false)
  })
})
