import { IdCard, MapPin } from 'lucide-react';
import type { VerifcoModule } from '../../app/modules';
import { lazyPage } from '../../lib/lazy';
import './customers.css';

const AddressTab = lazyPage(() => import('./CadastroTabs'), 'AddressTab');
const IdentificationTab = lazyPage(() => import('./CadastroTabs'), 'IdentificationTab');
const CustomersPage = lazyPage(() => import('./CustomersPage'), 'CustomersPage');

export const module: VerifcoModule = {
  routes: [{ path: 'clientes', element: <CustomersPage /> }],
  profileTabs: [
    { path: 'identificacao', label: 'Identificação', icon: IdCard, element: IdentificationTab, order: 60 },
    { path: 'endereco', label: 'Endereço', icon: MapPin, element: AddressTab, order: 70 },
  ],
};
