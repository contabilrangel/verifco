import { createContext, useContext, useState, type ReactNode } from 'react';
import { currentExerciseYear } from '@verifco/shared';

/**
 * Ano-exercício selecionado. É global: acompanha a navegação entre telas,
 * filtros, arquivos e relatórios, e fica salvo no navegador.
 */
const KEY = 'verifco.year';
const thisYear = currentExerciseYear();

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

const YEARS = Array.from({ length: 8 }, (_, i) => thisYear + 1 - i);
export const YEAR_OPTIONS = YEARS.map((y) => ({ value: String(y), label: `${y} · AC ${y - 1}` }));
/** Rótulos curtos para telas estreitas (o seletor da barra superior não cabe com "· AC"). */
export const YEAR_OPTIONS_SHORT = YEARS.map((y) => ({ value: String(y), label: String(y) }));
