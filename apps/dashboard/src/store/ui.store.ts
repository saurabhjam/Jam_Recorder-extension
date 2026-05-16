import { create } from 'zustand';

type ModalKey =
  | 'inviteMember'
  | 'deleteRecording'
  | 'editTitle'
  | 'createShareLink'
  | 'confirmDelete';

interface UIStore {
  sidebarOpen: boolean;
  theme: 'dark' | 'light';
  activeModal: ModalKey | null;
  modalData: Record<string, unknown>;
  notifications: number;
  searchQuery: string;

  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setTheme: (theme: 'dark' | 'light') => void;
  openModal: (key: ModalKey, data?: Record<string, unknown>) => void;
  closeModal: () => void;
  setNotifications: (count: number) => void;
  setSearchQuery: (q: string) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarOpen: true,
  theme: 'dark',
  activeModal: null,
  modalData: {},
  notifications: 0,
  searchQuery: '',

  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setTheme: (theme) => set({ theme }),
  openModal: (activeModal, modalData = {}) => set({ activeModal, modalData }),
  closeModal: () => set({ activeModal: null, modalData: {} }),
  setNotifications: (notifications) => set({ notifications }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
}));
