
import { DurableObject } from "cloudflare:workers";

const VERSION = "4.0-durable-objects";
const DEFAULT_STATE = {
  gameId: "default",
  version: VERSION,
  gameStarted: false,
  calledNumbers: [],
  cards: [],
  pattern: "FULL_HOUSE",
  claims: [],
  winner: null,
  updatedAt: Date.now()
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json"
    }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    let body = {};

    if (request.method !== "GET") {
      body = await request.clone().json().catch(() => ({}));
    }

    const gameId =
      url.searchParams.get("gameId") ||
      url.searchParams.get("gameCode") ||
      body.gameId ||
      body.gameCode ||
      request.headers.get("X-Game-ID") ||
      "default";

    if (!env.BINGO_ROOMS) {
      return json({
        error: "Missing Durable Object binding BINGO_ROOMS. Add binding to class BingoGameRoom."
      }, 500);
    }

    const id = env.BINGO_ROOMS.idFromName(String(gameId));
    const room = env.BINGO_ROOMS.get(id);

    return room.fetch(request);
  }
};

export class BingoGameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async getState() {
    let state = await this.ctx.storage.get("state");

    if (!state) {
      state = { ...DEFAULT_STATE };
      await this.ctx.storage.put("state", state);
    }

    return state;
  }

  async saveState(state) {
    state.updatedAt = Date.now();
    await this.ctx.storage.put("state", state);
    return state;
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    let state = await this.getState();

    if (path === "/" || path === "/health") {
      return json({
        server: "ELIAS BINGO",
        status: "online",
        version: VERSION,
        storage: "Durable Objects SQLite",
        gameId: state.gameId
      });
    }

    if (method === "GET" && path === "/state") {
      return json(state);
    }

    let body = {};
    if (method !== "GET") {
      body = await request.json().catch(() => ({}));
    }

    if (body.gameId || body.gameCode) {
      state.gameId = body.gameId || body.gameCode;
    }

    if (method === "POST") {
      switch (path) {
        case "/admin/register": {
          if (Array.isArray(body.cards)) {
            state.cards = body.cards;
          }
          break;
        }

        case "/admin/pattern": {
          state.pattern = body.pattern || body.value || state.pattern;
          break;
        }

        case "/admin/start": {
          state.gameStarted = true;
          break;
        }

        case "/admin/called": {
          const number = Number(
            body.number ?? body.calledNumber ?? body.value
          );

          if (Array.isArray(body.numbers)) {
            for (const n of body.numbers) {
              const value = Number(n);
              if (value >= 1 && value <= 75 &&
                  !state.calledNumbers.includes(value)) {
                state.calledNumbers.push(value);
              }
            }
          } else if (
            Number.isInteger(number) &&
            number >= 1 &&
            number <= 75 &&
            !state.calledNumbers.includes(number)
          ) {
            state.calledNumbers.push(number);
          }
          break;
        }

        case "/admin/bingo":
        case "/bingo": {
          const claim = {
            id: crypto.randomUUID(),
            cardNumber: body.cardNumber ?? body.card ?? null,
            player: body.player || "Player",
            claimedAt: Date.now(),
            status: "pending",
            details: body
          };

          state.claims.push(claim);
          break;
        }

        case "/admin/confirm-winner": {
          const claim = state.claims.find(
            c => c.id === body.id ||
              String(c.cardNumber) === String(body.cardNumber)
          );

          if (claim) {
            claim.status = "confirmed";
            state.winner = claim;
          }
          break;
        }

        case "/admin/reject-bingo": {
          const claim = state.claims.find(
            c => c.id === body.id ||
              String(c.cardNumber) === String(body.cardNumber)
          );

          if (claim) {
            claim.status = "rejected";
          }
          break;
        }

        case "/admin/reset": {
          state = {
            ...DEFAULT_STATE,
            gameId: state.gameId
          };
          break;
        }

        default:
          return json({ error: "Unknown endpoint", path }, 404);
      }

      await this.saveState(state);
      return json({ success: true, state });
    }

    if (method === "GET" && path === "/admin/bingo") {
      return json({
        claims: state.claims,
        winner: state.winner
      });
    }

    return json({ error: "Endpoint not found", path }, 404);
  }
}

