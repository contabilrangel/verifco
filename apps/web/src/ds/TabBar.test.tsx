import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Input, Select, TabBar, Tabs, scrollToReveal } from './index';

describe('scrollToReveal', () => {
  it('não rola quando a aba já está inteira à vista (com a margem da seta)', () => {
    expect(scrollToReveal(0, 600, 100, 200)).toBeNull();
  });
  it('rola para a direita até a aba aparecer antes da seta', () => {
    // aba de 900 a 1000 numa barra de 600 px: rola até 1000 + 48 - 600
    expect(scrollToReveal(0, 600, 900, 1000)).toBe(448);
  });
  it('rola para a esquerda e nunca abaixo de zero', () => {
    expect(scrollToReveal(500, 600, 520, 600)).toBe(472);
    expect(scrollToReveal(500, 600, 10, 100)).toBe(0);
  });
});

/**
 * O jsdom não calcula layout: simulamos uma barra de 250 px com 5 abas de 100 px
 * (largura total 500 px). A posição de cada aba vem do atributo data-left.
 */
describe('TabBar', () => {
  let scroll = 0;
  beforeEach(() => {
    scroll = 0;
    const isBar = (el: HTMLElement) => el.classList.contains('vf-tabs');
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return Number(this.dataset.left ?? 0);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return isBar(this) ? 250 : 100;
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('vf-tabs') ? 250 : 100;
    });
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('vf-tabs') ? 500 : 100;
    });
    vi.spyOn(Element.prototype, 'scrollLeft', 'get').mockImplementation(() => scroll);
    vi.spyOn(Element.prototype, 'scrollLeft', 'set').mockImplementation((v: number) => {
      scroll = Math.min(Math.max(0, v), 250);
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const bar = (active: number) => (
    <TabBar label="Seções do cliente" activeKey={String(active)}>
      {[0, 1, 2, 3, 4].map((i) => (
        <a key={i} href={`#${i}`} data-left={i * 100} className={i === active ? 'vf-tab active' : 'vf-tab'}>
          Aba {i}
        </a>
      ))}
    </TabBar>
  );

  it('traz a aba ativa para a vista e mostra a seta de voltar', () => {
    render(bar(4));
    // última aba (400..500): rola até o fim
    expect(scroll).toBe(250);
    expect(screen.getByRole('navigation', { name: 'Seções do cliente' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ver abas anteriores' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ver mais abas' })).toBeNull();
  });

  it('ao trocar para a primeira aba volta ao início e mostra a seta de avançar', () => {
    const { rerender } = render(bar(4));
    rerender(bar(0));
    expect(scroll).toBe(0);
    expect(screen.queryByRole('button', { name: 'Ver abas anteriores' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ver mais abas' })).toBeTruthy();
  });

  it('a seta avança a rolagem', () => {
    render(bar(0));
    const scrollBy = vi.fn();
    (screen.getByRole('navigation') as HTMLElement).scrollBy = scrollBy as unknown as typeof Element.prototype.scrollBy;
    fireEvent.click(screen.getByRole('button', { name: 'Ver mais abas' }));
    expect(scrollBy).toHaveBeenCalledWith({ left: 175, behavior: 'smooth' });
  });
});

describe('Tabs', () => {
  afterEach(cleanup);
  it('usa a barra rolável e troca de aba', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        value="a"
        onChange={onChange}
        items={[
          { value: 'a', label: 'Visão geral' },
          { value: 'b', label: 'Orçamento' },
        ]}
      />,
    );
    expect(screen.getByRole('tablist').classList.contains('vf-tabs')).toBe(true);
    expect(screen.getByRole('tab', { name: 'Visão geral' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Orçamento' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('campos em grade (span)', () => {
  afterEach(cleanup);
  it('ocupam colunas por classe, e não por grid-column em linha', () => {
    render(
      <div className="vf-grid">
        <Input label="Nome completo" span={2} />
        <Select label="Categoria" span="full" options={[]} />
        <Input label="CPF" />
      </div>,
    );
    const wrap = (label: string) => screen.getByLabelText(label).closest('.vf-field') as HTMLElement;
    expect(wrap('Nome completo').className).toContain('vf-span-2');
    expect(wrap('Nome completo').style.gridColumn).toBe('');
    expect(wrap('Categoria').className).toContain('vf-span-full');
    expect(wrap('CPF').className).toBe('vf-field');
  });
});
