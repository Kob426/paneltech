export interface AdminGame {
  id: string;
  name: string;
  revision: number;
  exes: string[];
}

export interface AdminClub {
  id: string;
  name: string;
  version?: number;
  demo?: boolean;
  variants: { id: number; name: string }[];
}

export interface AdminEmployee {
  id: string;
  username: string;
  role: 'admin' | 'operator';
  disabled: boolean;
  version?: number;
  conflict?: boolean;
}

export interface AdminDevice {
  id: string;
  name: string;
  revoked?: boolean;
  demo?: boolean;
  accessVersion?: number;
  rotationRequested?: boolean;
  recoveryPending?: boolean;
}
