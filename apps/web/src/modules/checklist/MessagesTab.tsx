import { useCustomer } from '../customers/customerContext';
import { OfficeConversation } from '../messages/Conversation';

/** Aba "Mensagens" do perfil do cliente: a mesma conversa da caixa de mensagens (portal, WhatsApp e anexos). */
export function MessagesTab() {
  const { customer } = useCustomer();
  return <OfficeConversation customerId={customer.id} customerName={customer.name} />;
}
