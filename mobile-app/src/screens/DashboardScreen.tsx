import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { apiFetch } from '../services/api';

interface Stats {
  total_vendors: number;
  onboarded: number;
  interested: number;
  calls_today: number;
  calls_this_week: number;
  pending_quotes: number;
}

export default function DashboardScreen({ navigation }: any) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [recentCalls, setRecentCalls] = useState<any[]>([]);

  async function loadData() {
    try {
      const [vendorRes, callsRes] = await Promise.all([
        apiFetch('/admin/vendors?limit=1'),
        apiFetch('/admin/calls?limit=5'),
      ]);
      const vendorData = await vendorRes.json();
      const callsData = await callsRes.json();

      setStats({
        total_vendors: vendorData.total || 0,
        onboarded: vendorData.status_counts?.onboarded || 0,
        interested: vendorData.status_counts?.interested || 0,
        calls_today: callsData.today_count || callsData.calls?.length || 0,
        calls_this_week: callsData.total || 0,
        pending_quotes: vendorData.status_counts?.prospect || 0,
      });
      setRecentCalls(callsData.calls || []);
    } catch (e) {
      console.warn('Dashboard load failed:', e);
    }
  }

  useFocusEffect(useCallback(() => { loadData(); }, []));

  async function onRefresh() {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }

  function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
    return (
      <View style={[styles.statCard, { borderLeftColor: color }]}>
        <Text style={styles.statValue}>{value}</Text>
        <Text style={styles.statLabel}>{label}</Text>
      </View>
    );
  }

  const outcomeColors: Record<string, string> = {
    INTERESTED_EMAIL: '#22c55e',
    INTERESTED_CALLBACK: '#3b82f6',
    NOT_INTERESTED: '#ef4444',
    VOICEMAIL: '#94a3b8',
    NO_ANSWER: '#94a3b8',
    BLOCKED: '#f97316',
    COMPLETED: '#6366f1',
    FAILED: '#ef4444',
  };

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <Text style={styles.title}>Vendora</Text>
        <Text style={styles.subtitle}>Dashboard</Text>
      </View>

      <View style={styles.statsGrid}>
        <StatCard label="Total Vendors" value={stats?.total_vendors || 0} color="#3b82f6" />
        <StatCard label="Onboarded" value={stats?.onboarded || 0} color="#22c55e" />
        <StatCard label="Interested" value={stats?.interested || 0} color="#6366f1" />
        <StatCard label="Prospects" value={stats?.pending_quotes || 0} color="#f59e0b" />
      </View>

      <Text style={styles.sectionTitle}>Recent Calls</Text>
      {recentCalls.map((call: any) => (
        <TouchableOpacity
          key={call.call_id}
          style={styles.callRow}
          onPress={() => navigation.navigate('CallDetail', { call_id: call.call_id })}
        >
          <View style={styles.callInfo}>
            <Text style={styles.callName}>{call.vendor_name || call.canonical_name || 'Unknown'}</Text>
            <Text style={styles.callTime}>
              {new Date(call.initiated_at).toLocaleDateString()} · {call.call_type || 'onboarding'}
            </Text>
          </View>
          <View style={[
            styles.outcomeBadge,
            { backgroundColor: (outcomeColors[call.outcome] || '#94a3b8') + '20' },
          ]}>
            <Text style={[
              styles.outcomeText,
              { color: outcomeColors[call.outcome] || '#94a3b8' },
            ]}>
              {call.outcome || call.status || '—'}
            </Text>
          </View>
        </TouchableOpacity>
      ))}
      {recentCalls.length === 0 && (
        <Text style={styles.emptyText}>No recent calls</Text>
      )}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: { paddingTop: 60, paddingHorizontal: 20, paddingBottom: 16 },
  title: { fontSize: 28, fontWeight: '800', color: '#f8fafc' },
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 2 },
  statsGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: 12, gap: 8, marginBottom: 20,
  },
  statCard: {
    flex: 1, minWidth: '45%',
    backgroundColor: '#1e293b', borderRadius: 12,
    padding: 16, borderLeftWidth: 3, margin: 4,
  },
  statValue: { fontSize: 28, fontWeight: '700', color: '#f8fafc' },
  statLabel: { fontSize: 12, color: '#94a3b8', marginTop: 4 },
  sectionTitle: {
    fontSize: 16, fontWeight: '700', color: '#f8fafc',
    paddingHorizontal: 20, marginBottom: 8,
  },
  callRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#1e293b', marginHorizontal: 16, marginBottom: 6,
    borderRadius: 10, padding: 14,
  },
  callInfo: { flex: 1 },
  callName: { fontSize: 15, fontWeight: '600', color: '#f8fafc' },
  callTime: { fontSize: 12, color: '#64748b', marginTop: 2 },
  outcomeBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  outcomeText: { fontSize: 11, fontWeight: '600' },
  emptyText: { color: '#64748b', textAlign: 'center', marginTop: 20, fontSize: 14 },
});
