import { IdCard, MapPin } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { AddressTab, IdentificationTab } from './CadastroTabs';
import { CustomersPage } from './CustomersPage';
import './customers.css';

export const module: VerifcoModule = {
  routes: [{ path: 'clientes', element: <CustomersPage /> }],
  profileTabs: [
    { path: 'identificacao', label: 'Identificação', icon: IdCard, element: IdentificationTab, order: 60 },
    { path: 'endereco', label: 'Endereço', icon: MapPin, element: AddressTab, order: 70 },
  ],
};
