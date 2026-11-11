import { readFileSync } from 'node:fs';

/** Versão do sincronizador: a do `package.json` (único lugar onde ela é definida). */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** Valor do cabeçalho `X-Verifco-Client`, enviado em todos os pedidos (ex.: `sync/0.3.0 (win32)`). */
export const clientHeader = (version: string = VERSION, platform: string = process.platform) => `sync/${version} (${platform})`;

/** Bloco `client` do `GET /api/sync/whoami` (ausente em servidores anteriores). */
export interface ClientInfo {
  latest?: string | null;
  minSupported?: string | null;
  updateAvailable?: boolean;
  unsupported?: boolean;
}

/** Compara versões `a.b.c` (negativo: a < b; zero: iguais; positivo: a > b). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export interface UpdateNotice {
  level: 'update' | 'unsupported';
  text: string;
}

/**
 * Aviso de atualização a partir do `client` do whoami, ou `null` quando não há o que avisar
 * (servidor anterior, sem o bloco, ou versão em dia). Os indicadores do servidor valem; se
 * faltarem, a comparação é feita aqui com `latest` e `minSupported`.
 */
export function updateNotice(client: ClientInfo | null | undefined, version: string = VERSION): UpdateNotice | null {
  if (!client) return null;
  const latest = client.latest || null;
  const min = client.minSupported || null;
  const unsupported = client.unsupported ?? (min ? compareVersions(version, min) < 0 : false);
  const updateAvailable = client.updateAvailable ?? (latest ? compareVersions(version, latest) < 0 : false);
  if (unsupported) {
    return {
      level: 'unsupported',
      text:
        `ATENÇÃO: a versão ${version} do sincronizador NÃO É MAIS ACEITA pelo Verifco${min ? ` (mínima aceita: ${min})` : ''}; os envios podem ser recusados. ` +
        `Baixe a versão ${latest ?? 'atual'} na Central de downloads do Verifco, descompacte por cima desta pasta e inicie o sincronizador de novo.`,
    };
  }
  if (updateAvailable) {
    return {
      level: 'update',
      text: `Há uma versão nova do sincronizador: ${latest ?? 'mais recente'} (instalada: ${version}). Baixe na Central de downloads do Verifco e descompacte por cima desta pasta.`,
    };
  }
  return null;
}
