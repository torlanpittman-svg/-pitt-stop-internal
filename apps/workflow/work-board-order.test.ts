import { describe, it, expect } from 'vitest'
import { workBoardRank, sortWorkBoard, type BoardSortable } from './work-board-order'

// Minimal board-order fixtures. source/serviceType drive orderSourceKind (retail vs dealer vs unknown);
// `n` is a stable label so we can assert age-order preservation within a group.
type Item = BoardSortable & { n: string }
const retail = (n: string, isUrgent = false): Item => ({ n, isUrgent, source: 'retail', serviceType: 'retail' })
const dealer = (n: string, isUrgent = false): Item => ({ n, isUrgent, source: 'dealer', serviceType: 'dealer' })

describe('workBoardRank — canonical Work Board display priority', () => {
  it('URGENT (any source) ranks above every non-urgent vehicle', () => {
    expect(workBoardRank(dealer('d', true))).toBeLessThan(workBoardRank(retail('r')))   // urgent dealer > non-urgent retail
    expect(workBoardRank(retail('r', true))).toBeLessThan(workBoardRank(retail('r2')))   // urgent retail > non-urgent retail
    expect(workBoardRank(retail('r', true))).toBe(workBoardRank(dealer('d', true)))      // all urgent share the top group
  })
  it('non-urgent RETAIL ranks above non-urgent DEALER', () => {
    expect(workBoardRank(retail('r'))).toBeLessThan(workBoardRank(dealer('d')))
  })
  it('non-urgent UNKNOWN sorts last among non-urgent', () => {
    const unknown: BoardSortable = { isUrgent: false, source: null, serviceType: null }
    expect(workBoardRank(unknown)).toBeGreaterThan(workBoardRank(dealer('d')))
  })
})

describe('sortWorkBoard — full ordering', () => {
  it('orders urgent → non-urgent retail → non-urgent dealer', () => {
    const board = sortWorkBoard([dealer('d1'), retail('r1'), dealer('d2', true), retail('r2', true)])
    // Two urgent first (both preserve incoming order), then non-urgent retail, then non-urgent dealer.
    expect(board.map((o) => (o as Item).n)).toEqual(['d2', 'r2', 'r1', 'd1'])
  })

  it('urgent dealer outranks non-urgent retail', () => {
    const board = sortWorkBoard([retail('r'), dealer('d', true)])
    expect((board[0] as Item).n).toBe('d')
  })

  it('urgent retail outranks non-urgent retail', () => {
    const board = sortWorkBoard([retail('old'), retail('new', true)])
    expect((board[0] as Item).n).toBe('new')
  })

  it('non-urgent retail outranks non-urgent dealer', () => {
    const board = sortWorkBoard([dealer('d'), retail('r')])
    expect((board[0] as Item).n).toBe('r')
  })

  it('same-priority vehicles retain incoming age order (stable)', () => {
    // Incoming list is oldest-first; within the same group that order must be preserved.
    const board = sortWorkBoard([retail('r1'), retail('r2'), retail('r3')])
    expect(board.map((o) => (o as Item).n)).toEqual(['r1', 'r2', 'r3'])

    const urgentGroup = sortWorkBoard([dealer('u1', true), retail('u2', true), dealer('u3', true)])
    expect(urgentGroup.map((o) => (o as Item).n)).toEqual(['u1', 'u2', 'u3'])
  })

  it('does not mutate the input array', () => {
    const input = [dealer('d'), retail('r', true)]
    const copy = [...input]
    sortWorkBoard(input)
    expect(input).toEqual(copy)
  })
})
