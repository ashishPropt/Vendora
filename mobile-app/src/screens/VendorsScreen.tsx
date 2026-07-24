import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { apiFetch } from '../services/api';
import { Vendor } from '../types';

const STATUS_FILTERS = ['all', 'prospect', 'interested', 'onboarded', 'unreachable'];
const STATUS_COLORS: Record<string, string> = {
  prospect: '#f59e0b',
  interested: '#6366f1',
  onboarded: '#22c55e',
  callback: '#3b82f6',
  declined: '#ef4444',
  unreachable: '#94a3b8',
  contacted: '#8b5cf6',
  test: '#64748b',
};

export default function VendorsScreen({ navigation }: any) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function loadVendors(p = 1, refresh = false) {
    if (loading && !refresh) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(p),
        limit: '25',
        ...(search ? { q: search } : {}),
        ...(status !== 'all' ? { status } : {}),
      });
      const res = await apiFetch(`/admin/vendors?${params}`);
      const data = await res.json();
      const list = data.vendors || [];
      setVendors(p === 1 ? list : [...vendors, ...list]);
      setTotal(data.total || 0);
      setPage(p);
    } catch (e) {
      console.warn('Vendor load failed:', e);
    }
    setLoading(false);
  }

  useFocusEffect(useCallback(() => { loadVendors(1); }, [status, search]));

  function onRefresh() {
    setRefreshing(true);
    loadVendors(1, true).then(() => setRefreshing(false));
  }

  function renderVendor({ item }: { item: Vendor }) {
    const statusColor = STATUS_COLORS[item.lifecycle_status] || '#64748b';
    return (
      <TouchableOpacity
        style={styles.vendorCard}
        onPress={() => navigation.navigate('VendorDetail', { vendor: item })}
      >
        <View style={styles.vendorRow}>
          <View style={styles.vendorInfo}>
            <Text style={styles.vendorName} numberOfLines={1}>{item.canonical_name}</Text>
            <Text style={styles.vendorMeta}>
              {item.category_display_name || '—'} · {item.city || ''}{item.state ? `, ${item.state}` : ''}
            </Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>
              {item.lifecycle_status || '—'}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Vendors</Text>
        <Text style={styles.count}>{total} total</Text>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search vendors..."
          placeholderTextColor="#64748b"
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
      </View>

      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((s) => (
          <TouchableOpacity
            key={s}
            style={[styles.filterChip, status === s && styles.filterActive]}
            onPress={() => setStatus(s)}
          >
            <Text style={[styles.filterText, status === s && styles.filterTextActive]}>
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={vendors}
        keyExtractor={(v) => String(v.vendor_id)}
        renderItem={renderVendor}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        onEndReached={() => {
          if (vendors.length < total) loadVendors(page + 1);
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={loading ? <ActivityIndicator style={{ padding: 20 }} color="#3b82f6" /> : null}
        ListEmptyComponent={
          !loading ? <Text style={styles.emptyText}>No vendors found</Text> : null
        }
        contentContainerStyle={{ paddingBottom: 20 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: {
    paddingTop: 60, paddingHorizontal: 20, paddingBottom: 12,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
  },
  title: { fontSize: 28, fontWeight: '800', color: '#f8fafc' },
  count: { fontSize: 14, color: '#64748b' },
  searchRow: { paddingHorizontal: 16, marginBottom: 8 },
  searchInput: {
    backgroundColor: '#1e293b', borderRadius: 10, padding: 12,
    fontSize: 15, color: '#f8fafc', borderWidth: 1, borderColor: '#334155',
  },
  filterRow: {
    flexDirection: 'row', paddingHorizontal: 16,
    marginBottom: 12, gap: 6,
  },
  filterChip: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 16, backgroundColor: '#1e293b',
  },
  filterActive: { backgroundColor: '#2563eb' },
  filterText: { fontSize: 12, color: '#94a3b8', fontWeight: '600' },
  filterTextActive: { color: '#fff' },
  vendorCard: {
    backgroundColor: '#1e293b', marginHorizontal: 16, marginBottom: 6,
    borderRadius: 10, padding: 14,
  },
  vendorRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  vendorInfo: { flex: 1, marginRight: 12 },
  vendorName: { fontSize: 15, fontWeight: '600', color: '#f8fafc' },
  vendorMeta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  statusText: { fontSize: 11, fontWeight: '600' },
  emptyText: { color: '#64748b', textAlign: 'center', marginTop: 40, fontSize: 14 },
});
