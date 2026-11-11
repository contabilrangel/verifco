import { NavLink } from 'react-router';
import { MessagesSquare } from 'lucide-react';
import { cx } from '../../ds';
import { useUnreadMessages } from './api';

/**
 * Item "Mensagens" do menu lateral, com o número de mensagens de clientes ainda não lidas.
 * Fica fora da lista `NAV` porque ela não tem como levar um selo; o Shell só o mostra para quem
 * pode ler as conversas (`customer.list`).
 */
export function MessagesNavItem() {
  const { count } = useUnreadMessages();
  return (
    <NavLink to="/mensagens" className={({ isActive }) => cx('sidebar__link', 'msg-nav', isActive && 'active')} title="Mensagens">
      <MessagesSquare />
      <span className="sidebar__label">Mensagens</span>
      {count > 0 && (
        <span className="vf-badge msg-nav__badge">
          {count > 99 ? '99+' : count}
          <span className="sr-only"> {count === 1 ? 'não lida' : 'não lidas'}</span>
        </span>
      )}
    </NavLink>
  );
}
