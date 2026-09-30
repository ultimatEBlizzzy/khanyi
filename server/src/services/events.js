/**
 * Realtime fan-out over Server-Sent Events.
 *
 * Why SSE instead of WebSockets? Order updates only ever travel
 * server → client. SSE gives us that on plain HTTP/1.1 (so it survives
 * every proxy and corporate firewall), auto-reconnects natively in the
 * browser, and needs zero extra dependencies.
 *
 * Every event gets a monotonic sequence number. Clients that reconnect
 * with `Last-Event-ID` (or `?since=`) receive the events they missed from
 * a bounded ring buffer before rejoining the live stream — so a rider who
 * drove through a dead spot still sees the order they were assigned.
 */
import { EventEmitter } from 'node:events';

const RING_SIZE = 500;

class EventHub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.seq = 0;
    this.ring = [];
    this.clients = new Set();
  }

  /** Publish an event to one or more topics. */
  publish(topics, type, payload) {
    const event = {
      seq: ++this.seq,
      id: String(this.seq),
      type,
      topics: Array.isArray(topics) ? topics : [topics],
      payload,
      at: new Date().toISOString(),
    };

    this.ring.push(event);
    if (this.ring.length > RING_SIZE) this.ring.shift();

    for (const client of this.clients) {
      if (event.topics.some((topic) => client.topics.has(topic) || client.topics.has('*'))) {
        writeEvent(client.res, event);
      }
    }

    // Internal listeners drive server-side workflows (auto-dispatch, stock
    // alerts). The public SSE stream is unaffected by how many exist.
    this.emit('event', event);
    return event;
  }

  /** Events newer than `sinceSeq` that the subscriber is allowed to see. */
  replaySince(sinceSeq, topics) {
    return this.ring.filter(
      (event) => event.seq > sinceSeq && event.topics.some((t) => topics.has(t) || topics.has('*')),
    );
  }

  stats() {
    const byTopic = {};
    for (const client of this.clients) {
      for (const topic of client.topics) byTopic[topic] = (byTopic[topic] ?? 0) + 1;
    }
    return { clients: this.clients.size, sequence: this.seq, byTopic };
  }
}

function writeEvent(res, event) {
  try {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    /* the client vanished mid-write; the close handler will clean up */
  }
}

export const hub = new EventHub();

/** Ordered status timeline shared by the API, the UI and the tests. */
export const ORDER_FLOW = {
  collection: ['pending', 'confirmed', 'preparing', 'ready', 'completed'],
  delivery: [
    'pending',
    'confirmed',
    'preparing',
    'ready',
    'assigned',
    'picked_up',
    'on_the_way',
    'delivered',
    'completed',
  ],
};

export const STATUS_LABELS = {
  pending: 'Order placed',
  confirmed: 'Confirmed by store',
  preparing: 'In the kitchen',
  ready: 'Ready for collection',
  assigned: 'Rider assigned',
  picked_up: 'Collected by rider',
  on_the_way: 'On the way to you',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
  rejected: 'Declined',
};

export const ACTIVE_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'assigned', 'picked_up', 'on_the_way'];

/**
 * Register an SSE subscriber. Returns a disposer.
 */
export function subscribe(res, topics, { since } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected to Khanyisile\'s Kitchen live feed\n\n');

  const client = { res, topics: new Set(topics) };
  hub.clients.add(client);

  res.write(
    `event: hello\ndata: ${JSON.stringify({ sequence: hub.seq, topics, at: Date.now() })}\n\n`,
  );

  if (since && Number.isFinite(Number(since))) {
    for (const event of hub.replaySince(Number(since), client.topics)) writeEvent(res, event);
  }

  // Comment frames keep mobile proxies from closing an idle connection.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* handled on close */
    }
  }, 20_000);

  const dispose = () => {
    clearInterval(heartbeat);
    hub.clients.delete(client);
  };

  res.on('close', dispose);
  res.on('error', dispose);
  return dispose;
}

export default { hub, publish: hub.publish.bind(hub), subscribe, ORDER_FLOW, STATUS_LABELS };
