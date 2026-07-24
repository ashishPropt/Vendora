import React, { useEffect, useState, useCallback } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { loadToken, getRole, clearToken, apiFetch } from './src/services/api';

// Shared auth
import LoginScreen from './src/screens/LoginScreen';
import SignUpScreen from './src/screens/SignUpScreen';

// Admin screens
import DashboardScreen from './src/screens/DashboardScreen';
import VendorsScreen from './src/screens/VendorsScreen';
import VendorDetailScreen from './src/screens/VendorDetailScreen';
import CallHistoryScreen from './src/screens/CallHistoryScreen';
import CallDetailScreen from './src/screens/CallDetailScreen';
import ScanCardScreen from './src/screens/ScanCardScreen';
import CardResultScreen from './src/screens/CardResultScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import AdminRfqScreen from './src/screens/AdminRfqScreen';

// Vendor screens
import VendorJobsScreen from './src/screens/VendorJobsScreen';
import RfqChatScreen from './src/screens/RfqChatScreen';
import QuoteHistoryScreen from './src/screens/QuoteHistoryScreen';
import VendorProfileScreen from './src/screens/VendorProfileScreen';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true }),
});

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  const icons: Record<string, string> = {
    Dashboard: '📊', Vendors: '🏢', Calls: '📞', Scan: '📷', RFQs: '📋', Settings: '⚙️',
    Jobs: '📋', History: '📜', Profile: '👤',
  };
  return <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.5 }}>{icons[label] || '•'}</Text>;
}

const TAB_BAR_STYLE = {
  backgroundColor: '#1e293b', borderTopColor: '#334155', paddingBottom: 6, paddingTop: 4, height: 60,
};

const HEADER_OPTS = { headerStyle: { backgroundColor: '#1e293b' }, headerTintColor: '#f8fafc' };

function AdminTabs({ onLogout }: { onLogout: () => void }) {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ focused }) => <TabIcon label={route.name} focused={focused} />,
        tabBarActiveTintColor: '#2563eb',
        tabBarInactiveTintColor: '#94a3b8',
        tabBarStyle: TAB_BAR_STYLE,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Vendors" component={VendorsScreen} />
      <Tab.Screen name="Calls" component={CallHistoryScreen} />
      <Tab.Screen name="RFQs" component={AdminRfqScreen} />
      <Tab.Screen name="Scan" component={ScanCardScreen} />
      <Tab.Screen name="Settings">
        {(props) => <SettingsScreen {...props} onLogout={onLogout} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

function VendorTabs({ onLogout }: { onLogout: () => void }) {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ focused }) => <TabIcon label={route.name} focused={focused} />,
        tabBarActiveTintColor: '#16a34a',
        tabBarInactiveTintColor: '#94a3b8',
        tabBarStyle: TAB_BAR_STYLE,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      })}
    >
      <Tab.Screen name="Jobs" component={VendorJobsScreen} />
      <Tab.Screen name="History" component={QuoteHistoryScreen} />
      <Tab.Screen name="Profile">
        {(props) => <VendorProfileScreen {...props} onLogout={onLogout} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

async function registerPushToken() {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return;
    const tokenData = await Notifications.getExpoPushTokenAsync();
    await apiFetch('/vendor/push-token', {
      method: 'POST',
      body: JSON.stringify({ expo_token: tokenData.data }),
    });
  } catch {}
}

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [role, setRole] = useState<'admin' | 'vendor' | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadToken().then(async (t) => {
      if (t) {
        const r = await getRole();
        setRole(r);
        setIsLoggedIn(true);
        if (r === 'vendor') registerPushToken();
      }
      setReady(true);
    });
  }, []);

  const handleLogin = useCallback((loginRole: 'admin' | 'vendor') => {
    setRole(loginRole);
    setIsLoggedIn(true);
    if (loginRole === 'vendor') registerPushToken();
  }, []);

  const handleLogout = useCallback(async () => {
    await clearToken();
    setIsLoggedIn(false);
    setRole(null);
  }, []);

  if (!ready) return null;

  return (
    <>
      <StatusBar style="light" />
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false, ...HEADER_OPTS }}>
          {!isLoggedIn ? (
            <>
              <Stack.Screen name="Login">
                {(props) => <LoginScreen {...props} onLogin={handleLogin} />}
              </Stack.Screen>
              <Stack.Screen name="SignUp" options={{ headerShown: true, title: 'Create Account', ...HEADER_OPTS }}>
                {(props) => <SignUpScreen {...props} onLogin={handleLogin} />}
              </Stack.Screen>
            </>
          ) : role === 'vendor' ? (
            <>
              <Stack.Screen name="VendorMain">
                {() => <VendorTabs onLogout={handleLogout} />}
              </Stack.Screen>
              <Stack.Screen name="VendorChat" component={RfqChatScreen}
                options={{ headerShown: true, title: 'Job Details & Chat', ...HEADER_OPTS }} />
            </>
          ) : (
            <>
              <Stack.Screen name="Main">
                {() => <AdminTabs onLogout={handleLogout} />}
              </Stack.Screen>
              <Stack.Screen name="VendorDetail" component={VendorDetailScreen}
                options={{ headerShown: true, title: 'Vendor Details', ...HEADER_OPTS }} />
              <Stack.Screen name="CallDetail" component={CallDetailScreen}
                options={{ headerShown: true, title: 'Call Details', ...HEADER_OPTS }} />
              <Stack.Screen name="CardResult" component={CardResultScreen}
                options={{ headerShown: true, title: 'Card Result', ...HEADER_OPTS }} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </>
  );
}
