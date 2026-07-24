export interface Vendor {
  vendor_id: number;
  canonical_name: string;
  primary_phone: string;
  city: string;
  state: string;
  category_display_name: string;
  is_onboarded: boolean;
  is_active: boolean;
  lifecycle_status: string;
  last_call_outcome?: string;
  last_call_at?: string;
}

export interface JobLead {
  quote_request_id: string;
  service_type: string;
  property_type: string;
  location: string;
  urgency: string;
  description: string;
  created_at: string;
  status: string;
  vendor_count: number;
}

export interface CallRecord {
  call_id: string;
  vapi_call_id: string;
  vendor_id: number;
  vendor_name: string;
  status: string;
  outcome: string;
  summary: string;
  transcript: string;
  initiated_at: string;
  ended_at: string;
  call_type: string;
}

export interface BusinessCard {
  name: string;
  company: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  website: string;
  category: string;
}

export interface User {
  id: number;
  email: string;
  role: string;
}
