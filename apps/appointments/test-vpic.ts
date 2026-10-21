/** Test helper: a stand-in for NHTSA vPIC GetModelsForMakeYear that never touches the network. */
export function fakeVpic(models: Record<string, string[]> = { Honda: ['Accord', 'Civic', 'CR-V'] }, opts: { fail?: boolean } = {}): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (opts.fail) throw new Error('network down')
    const make = decodeURIComponent(String(url).match(/\/make\/([^/]+)\//)?.[1] ?? '')
    const type = String(url).match(/vehicletype\/(\w+)/)?.[1]
    // Return each model once (under "car") like vPIC splits them by vehicle type.
    const list = type === 'car' || type === 'motorcycle' ? models[make] ?? [] : []
    return new Response(JSON.stringify({ Count: list.length, Results: list.map((m) => ({ Model_Name: m })) }), { status: 200 })
  }) as typeof fetch
}
