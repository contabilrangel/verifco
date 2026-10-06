import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * Ano-exercício selecionado. É global: acompanha a navegação entre telas,
 * filtros, arquivos e relatórios, e fica salvo no navegador.
 */
const KEY = 'verifco.year';
const thisYear = new Date().getFullYear();

const read = () => {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v >= 2015 && v <= thisYear + 1 ? v : thisYear;
  } catch {
    return thisYear;
  }
};

const Ctx = createContext<{ year: number; setYear: (y: number) => void }>({ year: thisYear, setYear: () => {} });

export function YearProvider({ children }: { children: ReactNode }) {
  const [year, set] = useState(read);
  const setYear = (y: number) => {
    set(y);
    try {
      localStorage.setItem(KEY, String(y));
    } catch {
      /* ignora */
    }
  };
  return <Ctx.Provider value={{ year, setYear }}>{children}</Ctx.Provider>;
}

export const useYear = () => useContext(Ctx);

export const YEAR_OPTIONS = Array.from({ length: 8 }, (_, i) => thisYear + 1 - i).map((y) => ({ value: String(y), label: `${y} · AC ${y - 1}` }));
