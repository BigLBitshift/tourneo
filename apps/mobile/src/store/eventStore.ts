import { create } from 'zustand';
import apiClient from '../api/client';

export interface Event {
  id: number;
  uuid: string;
  title: string;
  description: string | null;
  sport_category: string;
  start_date: string;
  end_date: string;
  registration_opens_at: string;
  registration_closes_at: string;
  club_early_access_at: string | null;
  plus_early_access_at: string | null;
  is_indoor: boolean;
  is_outdoor: boolean;
  format: string;
  elimination_type?: 'single_elimination' | 'double_elimination' | 'round_robin';
  max_participants: number;
  entry_fee_cents: number;
  currency: string;
  total_prize_pool_cents: number;
  level: string;
  access_type: string;
  has_food_drinks: boolean;
  has_streaming: boolean;
  special_notes: string | null;
  rules_summary?: string | null;
  banner_image_url: string | null;
  status: string;
  participant_count: number;
  spots_remaining: number;
  venue: {
    name: string | null;
    city: string | null;
    latitude?: number | null;
    longitude?: number | null;
  };
  prize_distribution?: Array<{
    place: number;
    amount_cents: number;
    label: string | null;
  }>;
}

interface EventState {
  events: Event[];
  currentEvent: Event | null;
  loading: boolean;
  error: string | null;
  filters: Record<string, any>;
  meta: { page: number; total: number; total_pages: number };

  fetchEvents: (filters?: Record<string, any>) => Promise<void>;
  fetchEventById: (id: number) => Promise<void>;
  setFilters: (filters: Record<string, any>) => void;
  clearFilters: () => void;
  reset: () => void;
}

export const useEventStore = create<EventState>((set, get) => ({
  events: [],
  currentEvent: null,
  loading: false,
  error: null,
  filters: {},
  meta: { page: 1, total: 0, total_pages: 0 },

  fetchEvents: async (filters?: Record<string, any>) => {
    set({ loading: true, error: null });
    try {
      const params = { ...get().filters, ...filters };
      const response = await apiClient.get('/events', { params });
      // The backend always returns { data: Event[], meta: {...} } for the
      // listing endpoint, but be defensive: if data is missing/null we
      // fall back to an empty list so consumers can safely .map() it.
      const data = Array.isArray(response.data?.data) ? response.data.data : [];
      const meta = response.data?.meta ?? { page: 1, total: 0, total_pages: 0 };
      set({
        events: data,
        meta,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: 'Turniere konnten nicht geladen werden.' });
      console.error('Failed to fetch events:', error);
    }
  },

  fetchEventById: async (id: number) => {
    set({ loading: true, error: null });
    try {
      const response = await apiClient.get(`/events/${id}`);
      set({ currentEvent: response.data.data, loading: false });
    } catch (error) {
      set({ loading: false, error: 'Event konnte nicht geladen werden.' });
      console.error('Failed to fetch event:', error);
    }
  },

  setFilters: (filters: Record<string, any>) => {
    set({ filters: { ...get().filters, ...filters } });
  },

  clearFilters: () => {
    set({ filters: {} });
  },

  reset: () => {
    set({
      events: [],
      currentEvent: null,
      loading: false,
      error: null,
      filters: {},
      meta: { page: 1, total: 0, total_pages: 0 },
    });
  },
}));