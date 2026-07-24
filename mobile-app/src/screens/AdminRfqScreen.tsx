import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, ActivityIndicator, RefreshControl,
  TouchableOpacity, Modal, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { apiFetch } from '../services/api';

interface VendorResponse {
  vendor_name: string;
  vendor_status: string;
  quoted_amount: number | null;
  quoted_at: string | null;
}

interface RfqItem {
  quote_request_id: string;
  category_label: string;
  address: string;
  city: string;
  state: string;
  description: string;
  property_type: string;
  urgency: string;
  requester_name: string;
  status: string;
  vendors_called: number;
  quotes_received: number;
  created_at: string;
  vendor_responses: VendorResponse[] | null;
}

const RFQ_STATUS: Record<string, { color: string; bg: string; label: string }> = {
  open:      { color: '#60a5fa', bg: '#1e3a5f', label: 'Open' },
  quoted:    { color: '#4ade80', bg: '#14532d', label: 'Quoted' },
  accepted:  { color: '#34d399', bg: '#064e3b', label: 'Accepted' },
  scheduled: { color: '#a78bfa', bg: '#2e1065', label: 'Scheduled' },
  completed: { color: '#94a3b8', bg: '#1e293b', label: 'Completed' },
  cancelled: { color: '#f87171', bg: '#450a0a', label: 'Cancelled' },
  expired:   { color: '#64748b', bg: '#0f172a', label: 'Expired' },
};

export default function AdminRfqScreen() {
  const [rfqs, setRfqs] = useState<RfqItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<RfqItem | null>(null);
  const [filter, setFilter] = useState('');

  async function fetchRfqs() {
    try {
      const res = await apiFetch('/admin/rfqs?limit=100');
      if (res.ok) {
        const d = await res.json();
        setRfqs(d.rfqs || []);
      }
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }

  useFocusEffect(useCallback(() => { fetchRfqs(); }, []));

  const filtered = filter
    ? rfqs.filter(r => r.status === filter)
    : rfqs;

  const counts = rfqs.reduce((acc: Record<string, number>, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  function renderItem({ item }: { item: RfqItem }) {
    const cfg = RFQ_STATUS[item.status] || RFQ_STATUS.open;
    const hasQuotes = (item.quotes_received || 0) > 0;
    return (
      <TouchableOpacity style={styles.card} onPress={() => setSelected(item)}>
        <View style={styles.cardTop}>
          <Text style={styles.category}>{item.category_label}</Text>
          <View style={[styles.badge, { backgroundColor: cfg.bg }]}>
            <Text style={[styles.badgeText, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
        </View>
        <Text style={styles.address}>{item.address}, {item.city}, {item.state}</Text>
        {item.requester_name ? <Text style={styles.requester}>by {item.requester_name}</Text> : null}
        <View style={styles.stats}>
          <Text style={styles.statText}>👥 {item.vendors_called || 0} contacted</Text>
          <Text style={[styles.statText, hasQuotes && styles.statHighlight]}>
            💬 {item.quotes_received || 0} quote{(item.quotes_received || 0) !== 1 ? 's' : ''}
          </Text>
          <Text style={styles.statDate}>{new Date(item.created_at).toLocaleDateString()}</Text>
        </View>
      </TouchableOpacity>
    );
  }

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color="#2563eb" /></View>;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>RFQ Monitor</Text>
        <Text style={styles.subtitle}>{rfqs.length} total · {counts['open'] || 0} open</Text>
      </View>

      {/* Filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterBar} contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingBottom: 8 }}>
        {[['', 'All'], ['open', 'Open'], ['quoted', 'Quoted'], ['accepted', 'Accepted'], ['completed', 'Done'], ['expired', 'Expired']].map(([val, label]) => (
          <TouchableOpacity key={val}
            style={[styles.filterChip, filter === val && styles.filterChipActive]}
            onPress={() => setFilter(val)}>
            <Text style={[styles.filterChipText, filter === val && styles.filterChipTextActive]}>
              {label}{val && counts[val] ? ` (${counts[val]})` : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        data={filtered}
        keyExtractor={r => r.quote_request_id}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 16, paddingTop: 4 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchRfqs(); }} tintColor="#2563eb" />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📋</Text>
            <Text style={styles.emptyText}>No RFQs found</Text>
          </View>
        }
      />

      {/* Detail modal */}
      <Modal visible={!!selected} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelected(null)}>
        {selected && (
          <View style={styles.modal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{selected.category_label}</Text>
              <TouchableOpacity onPress={() => setSelected(null)}>
                <Text style={styles.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody}>
              <Row label="Status" value={(RFQ_STATUS[selected.status] || RFQ_STATUS.open).label} />
              <Row label="Address" value={`${selected.address}, ${selected.city}, ${selected.state}`} />
              {selected.requester_name ? <Row label="Requester" value={selected.requester_name} /> : null}
              {selected.property_type ? <Row label="Property" value={selected.property_type} /> : null}
              {selected.urgency ? <Row label="Urgency" value={selected.urgency} /> : null}
              {selected.description ? <Row label="Description" value={selected.description} /> : null}
              <Row label="Created" value={new Date(selected.created_at).toLocaleString()} />
              <Row label="Vendors contacted" value={String(selected.vendors_called || 0)} />
              <Row label="Quotes received" value={String(selected.quotes_received || 0)} />

              {selected.vendor_responses && selected.vendor_responses.length > 0 && (
                <View style={styles.responsesSection}>
                  <Text style={styles.responseTitle}>Vendor Responses</Text>
                  {selected.vendor_responses.map((vr, i) => (
                    <View key={i} style={styles.responseRow}>
                      <Text style={styles.vendorName}>{vr.vendor_name || 'Unknown'}</Text>
                      <View style={styles.responseRight}>
                        {vr.quoted_amount != null && (
                          <Text style={styles.responseAmt}>${vr.quoted_amount}</Text>
                        )}
                        <Text style={[styles.responseStatus, { color: vr.vendor_status === 'quoted' ? '#4ade80' : '#64748b' }]}>
                          {vr.vendor_status}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </ScrollView>
          </View>
        )}
      </Modal>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  header: { paddingTop: 60, paddingHorizontal: 20, paddingBottom: 8 },
  title: { fontSize: 28, fontWeight: '800', color: '#f8fafc' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  filterBar: { flexGrow: 0, marginBottom: 4 },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: '#1e293b', borderWidth: 1, borderColor: '#334155' },
  filterChipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  filterChipText: { color: '#94a3b8', fontSize: 12, fontWeight: '600' },
  filterChipTextActive: { color: '#fff' },
  card: { backgroundColor: '#1e293b', borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#334155' },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  category: { fontSize: 15, fontWeight: '700', color: '#f8fafc', flex: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  address: { fontSize: 13, color: '#94a3b8', marginBottom: 2 },
  requester: { fontSize: 12, color: '#64748b', marginBottom: 6 },
  stats: { flexDirection: 'row', gap: 12, flexWrap: 'wrap', marginTop: 4 },
  statText: { fontSize: 12, color: '#64748b' },
  statHighlight: { color: '#4ade80' },
  statDate: { fontSize: 11, color: '#475569', marginLeft: 'auto' },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 16, fontWeight: '600', color: '#64748b' },
  modal: { flex: 1, backgroundColor: '#0f172a' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 24, borderBottomWidth: 1, borderBottomColor: '#334155' },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#f8fafc', flex: 1 },
  closeBtn: { fontSize: 20, color: '#64748b', paddingLeft: 16 },
  modalBody: { padding: 20 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1e293b' },
  rowLabel: { fontSize: 13, color: '#64748b', fontWeight: '600', flex: 0.4 },
  rowValue: { fontSize: 13, color: '#cbd5e1', flex: 0.6, textAlign: 'right' },
  responsesSection: { marginTop: 20 },
  responseTitle: { fontSize: 14, fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 10 },
  responseRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#1e293b' },
  vendorName: { fontSize: 14, color: '#f8fafc', flex: 1 },
  responseRight: { alignItems: 'flex-end' },
  responseAmt: { fontSize: 14, fontWeight: '700', color: '#4ade80' },
  responseStatus: { fontSize: 11, fontWeight: '600', marginTop: 2 },
});
