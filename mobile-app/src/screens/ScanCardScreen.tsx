import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image,
  ActivityIndicator, Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { scanBusinessCard } from '../services/cardScanner';
import { BusinessCard } from '../types';

export default function ScanCardScreen({ navigation }: any) {
  const [image, setImage] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  async function pickImage(useCamera: boolean) {
    const permMethod = useCamera
      ? ImagePicker.requestCameraPermissionsAsync
      : ImagePicker.requestMediaLibraryPermissionsAsync;
    const { status } = await permMethod();
    if (status !== 'granted') {
      Alert.alert('Permission needed', `Please grant ${useCamera ? 'camera' : 'photo library'} access.`);
      return;
    }

    const launcher = useCamera
      ? ImagePicker.launchCameraAsync
      : ImagePicker.launchImageLibraryAsync;

    const result = await launcher({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      base64: false,
    });

    if (!result.canceled && result.assets[0]) {
      setImage(result.assets[0].uri);
    }
  }

  async function handleScan() {
    if (!image) return;
    setScanning(true);
    try {
      const card: BusinessCard = await scanBusinessCard(image);
      navigation.navigate('CardResult', { card, imageUri: image });
    } catch (e: any) {
      Alert.alert('Scan Failed', e.message || 'Could not extract business card details.');
    }
    setScanning(false);
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Scan Card</Text>
        <Text style={styles.subtitle}>Import a business card to create a new vendor</Text>
      </View>

      <View style={styles.previewArea}>
        {image ? (
          <Image source={{ uri: image }} style={styles.preview} resizeMode="contain" />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderIcon}>📇</Text>
            <Text style={styles.placeholderText}>Take a photo or choose from gallery</Text>
          </View>
        )}
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={styles.captureBtn}
          onPress={() => pickImage(true)}
        >
          <Text style={styles.captureBtnText}>📷 Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.captureBtn}
          onPress={() => pickImage(false)}
        >
          <Text style={styles.captureBtnText}>🖼️ Gallery</Text>
        </TouchableOpacity>
      </View>

      {image && (
        <TouchableOpacity
          style={[styles.scanBtn, scanning && styles.scanBtnDisabled]}
          onPress={handleScan}
          disabled={scanning}
        >
          {scanning ? (
            <View style={styles.scanningRow}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.scanBtnText}>  Analyzing with AI...</Text>
            </View>
          ) : (
            <Text style={styles.scanBtnText}>🔍 Extract Business Info</Text>
          )}
        </TouchableOpacity>
      )}

      {image && (
        <TouchableOpacity
          style={styles.clearBtn}
          onPress={() => setImage(null)}
        >
          <Text style={styles.clearBtnText}>Clear</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', padding: 16 },
  header: { paddingTop: 50, marginBottom: 20 },
  title: { fontSize: 28, fontWeight: '800', color: '#f8fafc' },
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 4 },
  previewArea: {
    backgroundColor: '#1e293b', borderRadius: 16, height: 240,
    justifyContent: 'center', alignItems: 'center', overflow: 'hidden',
    borderWidth: 2, borderColor: '#334155', borderStyle: 'dashed',
  },
  preview: { width: '100%', height: '100%' },
  placeholder: { alignItems: 'center' },
  placeholderIcon: { fontSize: 48, marginBottom: 8 },
  placeholderText: { fontSize: 14, color: '#64748b' },
  buttonRow: {
    flexDirection: 'row', gap: 12, marginTop: 16,
  },
  captureBtn: {
    flex: 1, backgroundColor: '#1e293b', borderRadius: 10,
    padding: 14, alignItems: 'center', borderWidth: 1, borderColor: '#334155',
  },
  captureBtnText: { fontSize: 15, fontWeight: '600', color: '#f8fafc' },
  scanBtn: {
    backgroundColor: '#2563eb', borderRadius: 10,
    padding: 16, alignItems: 'center', marginTop: 16,
  },
  scanBtnDisabled: { opacity: 0.6 },
  scanningRow: { flexDirection: 'row', alignItems: 'center' },
  scanBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  clearBtn: { alignItems: 'center', marginTop: 12 },
  clearBtnText: { color: '#64748b', fontSize: 14 },
});
