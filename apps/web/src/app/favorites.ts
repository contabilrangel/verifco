/** Favorito gravado pela estrela do cabeçalho das páginas (PUT /auth/favorites). */
export interface Favorite {
  path: string;
  label: string;
}

/** Caminho interno da aplicação ("/clientes?busca=..."), nunca outro site ("//x", "/\x", "https:"). */
export const isInternalPath = (path: string) => /^\/(?![/\\])/.test(path);

/** Favoritos exibidos no menu lateral: só caminhos internos, em ordem alfabética. */
export function visibleFavorites(list: readonly Favorite[] | undefined): Favorite[] {
  return (list ?? []).filter((f) => isInternalPath(f.path)).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

/** O favorito corresponde à página aberta (caminho e busca exatos). */
export const isCurrentFavorite = (f: Favorite, location: { pathname: string; search: string }) => f.path === location.pathname + location.search;

/** Nome do favorito: título da página e, quando houver, a aba aberta ("Administração › Colaboradores"). */
export const favoriteLabel = (title: string, section?: string) => (section && section !== title ? `${title} › ${section}` : title).slice(0, 200);
