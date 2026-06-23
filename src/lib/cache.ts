import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { env } from '../env';

/**
 * Camada de cache da API.
 *
 * Dois drivers, mesma interface:
 *  - **memory** (default): cache pequeno em processo (Map com TTL + teto de
 *    entradas). Ideal para dados quentes lidos a cada request (ex.: a
 *    associação do usuário ao workspace). Zero infra, mas não é compartilhado
 *    entre instâncias e some no restart.
 *  - **redis** (quando `REDIS_URL` está definida): cache compartilhado e
 *    persistente entre instâncias/restarts. Bom para dados maiores ou pouco
 *    acessados que valem guardar fora do processo.
 *
 * Regra de ouro: o cache é *best-effort*. Qualquer falha (Redis fora do ar,
 * serialização) degrada para "miss" — a request segue batendo no banco. Cache
 * nunca derruba uma request.
 *
 * Namespacing: todas as chaves recebem o prefixo `ng:` para conviver com outros
 * usos do mesmo Redis sem colidir.
 */

const KEY_PREFIX = 'ng:';

export interface Cache {
  /** Driver em uso — só para logs/diagnóstico. */
  readonly driver: 'memory' | 'redis';
  /** Lê uma entrada; `undefined` em miss/expiração. */
  get<T>(key: string): Promise<T | undefined>;
  /** Grava uma entrada com TTL em segundos (default: TTL configurado). */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  /** Remove uma ou mais chaves exatas. */
  del(key: string | string[]): Promise<void>;
  /** Remove todas as chaves de um prefixo lógico (namespace). */
  delByPrefix(prefix: string): Promise<void>;
  /**
   * Lê do cache; em miss, roda o `loader`, grava o resultado e o devolve.
   * Deduplica chamadas concorrentes para a mesma chave (evita "cache stampede":
   * N requests simultâneas em miss disparariam N queries — aqui só a 1ª roda).
   */
  getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T>;
  /** Fecha conexões (Redis) e timers. No-op relevante para memória. */
  close(): Promise<void>;
}

/** Mixin com o `getOrSet` deduplicado, compartilhado pelos dois drivers. */
abstract class BaseCache implements Cache {
  abstract readonly driver: 'memory' | 'redis';
  abstract get<T>(key: string): Promise<T | undefined>;
  abstract set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  abstract del(key: string | string[]): Promise<void>;
  abstract delByPrefix(prefix: string): Promise<void>;
  abstract close(): Promise<void>;

  /** Promessas em voo por chave, para colapsar misses concorrentes. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  async getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== undefined) return hit;

    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = (async () => {
      const value = await loader();
      // Não cacheia null/undefined: deixa o "não existe" sempre revalidar (ex.:
      // membro recém-adicionado passa a ter acesso na hora, sem esperar TTL).
      if (value !== null && value !== undefined) {
        await this.set(key, value, ttlSeconds);
      }
      return value;
    })().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }
}

interface MemoryEntry {
  value: unknown;
  /** epoch ms em que a entrada expira. */
  expiresAt: number;
}

/** Cache em processo: Map com TTL e teto de entradas (evicção LRU-ish por idade). */
class MemoryCache extends BaseCache {
  readonly driver = 'memory' as const;
  private readonly store = new Map<string, MemoryEntry>();
  private readonly maxEntries: number;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(maxEntries: number) {
    super();
    this.maxEntries = maxEntries;
    // Varredura periódica de expirados, para o Map não crescer com entradas
    // que nunca mais são lidas. `unref` para não segurar o processo no exit.
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds = env.CACHE_DEFAULT_TTL_SECONDS): Promise<void> {
    // Reinsere no fim (Map preserva ordem de inserção → o "mais novo" é o último).
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    if (this.store.size > this.maxEntries) this.evictOldest();
  }

  async del(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) this.store.delete(k);
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    this.store.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(k);
    }
  }

  private evictOldest(): void {
    // Remove as entradas mais antigas até voltar ao teto (≈10% de folga p/ não
    // evictar a cada set quando lotado).
    const target = Math.floor(this.maxEntries * 0.9);
    for (const k of this.store.keys()) {
      if (this.store.size <= target) break;
      this.store.delete(k);
    }
  }
}

/** Subconjunto mínimo do ioredis que usamos — evita acoplar o tipo no compile. */
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  quit(): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Cache compartilhado em Redis. Toda operação é blindada: falha vira miss. */
class RedisCache extends BaseCache {
  readonly driver = 'redis' as const;
  constructor(
    private readonly redis: RedisLike,
    private readonly log: FastifyBaseLogger,
  ) {
    super();
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(key);
      if (raw == null) return undefined;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.log.warn({ err, key }, 'cache(redis) get falhou — tratando como miss');
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds = env.CACHE_DEFAULT_TTL_SECONDS): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.log.warn({ err, key }, 'cache(redis) set falhou — seguindo sem cachear');
    }
  }

  async del(key: string | string[]): Promise<void> {
    const keys = Array.isArray(key) ? key : [key];
    if (!keys.length) return;
    try {
      await this.redis.del(...keys);
    } catch (err) {
      this.log.warn({ err, keys }, 'cache(redis) del falhou');
    }
  }

  async delByPrefix(prefix: string): Promise<void> {
    try {
      let cursor = '0';
      do {
        const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        cursor = next;
        if (batch.length) await this.redis.del(...batch);
      } while (cursor !== '0');
    } catch (err) {
      this.log.warn({ err, prefix }, 'cache(redis) delByPrefix falhou');
    }
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // ignora erros de shutdown
    }
  }
}

/** Aplica o prefixo de namespace a um driver, mantendo a interface limpa. */
function withNamespace(inner: Cache): Cache {
  const k = (key: string) => `${KEY_PREFIX}${key}`;
  return {
    driver: inner.driver,
    get: (key) => inner.get(k(key)),
    set: (key, value, ttl) => inner.set(k(key), value, ttl),
    del: (key) => inner.del(Array.isArray(key) ? key.map(k) : k(key)),
    delByPrefix: (prefix) => inner.delByPrefix(k(prefix)),
    getOrSet: (key, ttl, loader) => inner.getOrSet(k(key), ttl, loader),
    close: () => inner.close(),
  };
}

/**
 * Cria o cache conforme o ambiente. Com `REDIS_URL` tenta conectar no Redis;
 * se a conexão inicial falhar, faz fallback para memória para não derrubar o
 * boot (o cache é opcional por design).
 */
export async function createCache(log: FastifyBaseLogger): Promise<Cache> {
  if (env.REDIS_URL) {
    try {
      // Import dinâmico: o ioredis só é exigido quando REDIS_URL está setada,
      // então o app roda sem a dependência instalada no modo memória.
      const mod = (await import('ioredis')) as unknown as {
        default: new (url: string, opts?: Record<string, unknown>) => RedisLike;
      };
      const RedisCtor = mod.default;
      const redis = new RedisCtor(env.REDIS_URL, {
        // Não pendura requests para sempre se o Redis cair: erra rápido e a
        // operação blindada degrada para miss.
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      redis.on('error', (err) => {
        log.warn({ err }, 'cache(redis) erro de conexão');
      });
      log.info('Cache: usando Redis (REDIS_URL definida)');
      return withNamespace(new RedisCache(redis, log));
    } catch (err) {
      log.error(
        { err },
        'Cache: falha ao iniciar Redis — usando cache em memória. Instale a dependência `ioredis` ou remova REDIS_URL.',
      );
    }
  }

  log.info('Cache: usando memória (in-process)');
  return withNamespace(new MemoryCache(env.CACHE_MAX_MEMORY_ENTRIES));
}

/**
 * Cache compartilhado em nível de processo, para contextos SEM Fastify (worker
 * da fila de importação, extração inline no serviço). Usa o mesmo driver e o
 * mesmo namespace (`ng:`) do `app.cache`, então uma chave gravada aqui é lida
 * lá e vice-versa — no mesmo processo (API + worker in-process) ou entre o
 * worker standalone e a API, quando ambos apontam para o mesmo Redis.
 *
 * Constrói o próprio logger Pino (não há `app.log` aqui). Mesma regra do resto
 * do cache: best-effort — sem `REDIS_URL` cai para memória (não sobrevive a
 * restart, mas reaproveita dentro do processo).
 */
let sharedCache: Promise<Cache> | null = null;

export function getSharedCache(): Promise<Cache> {
  if (!sharedCache) {
    // Cast: o Pino é estruturalmente compatível com o FastifyBaseLogger que o
    // createCache espera (usa só info/warn/error).
    const log = pino({ level: env.LOG_LEVEL }) as unknown as FastifyBaseLogger;
    sharedCache = createCache(log);
  }
  return sharedCache;
}

/** Fecha o cache compartilhado (chamado no shutdown dos entrypoints). */
export async function closeSharedCache(): Promise<void> {
  if (!sharedCache) return;
  const cache = await sharedCache;
  sharedCache = null;
  await cache.close();
}

// --- Chaves de cache (centralizadas p/ produtor e invalidador concordarem) ---

/** Associação (membership) de um usuário a um workspace. */
export function memberCacheKey(workspaceId: string, userId: string): string {
  return `member:${workspaceId}:${userId}`;
}

/**
 * Resultado da extração com IA de um documento, por workspace + provider/modelo
 * + hash do conteúdo. Permite reaproveitar o processamento de um documento já
 * lido (mesmo que o lote tenha sido descartado, ou o doc reenviado) sem repagar
 * tokens. Escopo por workspace de propósito — não compartilha leitura de doc
 * entre workspaces. O provider/modelo entram na chave porque a saída depende
 * deles (trocar de modelo deve reprocessar).
 */
export function extractionCacheKey(
  workspaceId: string,
  provider: string,
  model: string,
  contentHash: string,
): string {
  return `extract:${workspaceId}:${provider}:${model}:${contentHash}`;
}

/** Prefixo de todas as memberships de um workspace (p/ invalidação em massa). */
export function memberCachePrefix(workspaceId: string): string {
  return `member:${workspaceId}:`;
}

/** Catálogo de instituições visível a um workspace (globais + customizadas). */
export function institutionsCacheKey(workspaceId: string): string {
  return `institutions:${workspaceId}`;
}
