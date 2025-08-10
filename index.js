// src/App.js
import React, { useState, useCallback, useEffect, useMemo } from 'react';

// Polaris
import {
  Page,
  Card,
  Form,
  TextField,
  Button,
  Navigation,
  DataTable,
  Frame,
  TopBar,
  Banner,
  Spinner,
  Select,
  Layout,
  Modal,
  Text,
  IndexTable,
  Badge,
  InlineStack,
  Box,
  Divider,
  EmptyState,
} from '@shopify/polaris';
import '@shopify/polaris/build/esm/styles.css';

// App Bridge v4
import { useAppBridge } from '@shopify/app-bridge-react';

function MyApp() {
  const shopify = useAppBridge();

  // Seiten
  const [currentPage, setCurrentPage] = useState('batches'); // 'batches' | 'products' | 'traceability'

  // Externe Backend-URL
  const BACKEND_URL = 'https://shopify-lottracker-backend.onrender.com';

  // --- Produkte (für Auswahl/Übersicht) ---
  const [shopifyProducts, setShopifyProducts] = useState([]); // Select-Options [{label,value}]
  const [productsTable, setProductsTable] = useState([]);     // [{id,title,sku}]
  const [selectedProduct, setSelectedProduct] = useState(null); // {id,title,sku}

  // --- Formular "Neue Charge" (global + produktbezogen) ---
  const [selectedShopifyProduct, setSelectedShopifyProduct] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [quantity, setQuantity] = useState('');
  const [expiryTouched, setExpiryTouched] = useState(false); // verhindert Überschreiben nach manueller Änderung
  const [expirySuggested, setExpirySuggested] = useState(false); // UI-Hinweis

  // --- Chargenverwaltung ---
  const [batches, setBatches] = useState([]); // vom Backend
  const [loadingBatches, setLoadingBatches] = useState(false);

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [batchToEdit, setBatchToEdit] = useState(null);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [batchToDelete, setBatchToDelete] = useState(null);

  // --- Rückverfolgung ---
  const [searchBatch, setSearchBatch] = useState('');
  const [traceResults, setTraceResults] = useState([]);

  // --- Allgemein ---
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState(null); // {status: 'success'|'critical', message: string}

  // --------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------
  const getIdToken = useCallback(async () => {
    if (!shopify || typeof shopify.idToken !== 'function') {
      throw new Error('Shopify App Bridge ist nicht initialisiert.');
    }
    try {
      return await shopify.idToken();
    } catch (err) {
      console.error('idToken Fehler:', err);
      throw new Error('Authentifizierung fehlgeschlagen.');
    }
  }, [shopify]);

  const fetchWithAuth = useCallback(
    async (url, options = {}) => {
      const token = await getIdToken();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      };

      const response = await fetch(url, { ...options, headers });

      const status = response.status;
      const ct = response.headers.get('content-type') || '';
      const raw = await response.text().catch(() => '');

      if (!response.ok) {
        console.error('API error:', status, raw?.slice(0, 500));
        try {
          const parsed = raw ? JSON.parse(raw) : null;
          const msg = parsed?.message || parsed?.error || raw || 'Unbekannter Fehler';
          const err = new Error(msg);
          err.status = status;
          throw err;
        } catch (_) {
          const err = new Error(`API ${status} – ${raw?.slice(0, 200) || 'keine Antwort'}`);
          err.status = status;
          throw err;
        }
      }

      if (!ct.includes('application/json')) {
        console.error('Unerwarteter Content-Type (kein JSON):', ct, raw?.slice(0, 500));
        throw new Error('Unerwartete Antwort vom Server (kein JSON).');
      }

      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error('JSON-Parse-Fehler:', e, 'Roh-Body:', raw?.slice(0, 500));
        throw new Error('Antwort konnte nicht als JSON geparst werden.');
      }
    },
    [getIdToken]
  );

  // --------------------------------------------------------------------
  // Shopify GraphQL: Produkte laden
  // --------------------------------------------------------------------
  const fetchProductsFromShopify = useCallback(async () => {
    setLoading(true);
    try {
      const token = await getIdToken();

      const graphqlQuery = {
        query: `{
          products(first: 50) {
            edges {
              node {
                id
                title
                variants(first: 1) { edges { node { sku } } }
              }
            }
          }
        }`,
        variables: {},
      };

      const response = await fetch(`${BACKEND_URL}/api/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(graphqlQuery),
      });

      const status = response.status;
      const ct = response.headers.get('content-type') || '';
      const raw = await response.text().catch(() => '');

      if (!response.ok) {
        console.error('GraphQL error:', status, raw?.slice(0, 500));
        throw new Error(`GraphQL ${status} – ${raw?.slice(0, 200) || 'keine Antwort'}`);
      }
      if (!ct.includes('application/json')) {
        console.error('GraphQL: Kein JSON:', ct, raw?.slice(0, 500));
        throw new Error('Unerwartete Antwort vom Server (kein JSON).');
      }

      const jsonResponse = JSON.parse(raw);
      const edges = jsonResponse?.data?.products?.edges || [];

      // Select-Options + Tabelle befüllen
      const productOptions = edges.map((edge) => {
        const sku = edge?.node?.variants?.edges?.[0]?.node?.sku || 'N/A';
        return { label: `${edge.node.title} (SKU: ${sku})`, value: edge.node.id };
      });
      setShopifyProducts(productOptions);

      const list = edges.map((edge) => {
        const sku = edge?.node?.variants?.edges?.[0]?.node?.sku || 'N/A';
        return { id: edge.node.id, title: edge.node.title, sku };
      });
      setProductsTable(list);
    } catch (error) {
      console.error(error);
      setNotification({ status: 'critical', message: 'Shopify-Produkte konnten nicht geladen werden.' });
    } finally {
      setLoading(false);
    }
  }, [BACKEND_URL, getIdToken]);

  // --------------------------------------------------------------------
  // Chargenverwaltung – Laden, Erstellen, Bearbeiten, Löschen
  // --------------------------------------------------------------------
  const loadBatches = useCallback(async () => {
    setLoadingBatches(true);
    try {
      const data = await fetchWithAuth(`${BACKEND_URL}/api/batches`);
      setBatches(Array.isArray(data) ? data : data?.batches || []);
    } catch (error) {
      console.error(error);
      setNotification({ status: 'critical', message: 'Chargenliste konnte nicht geladen werden.' });
    } finally {
      setLoadingBatches(false);
    }
  }, [BACKEND_URL, fetchWithAuth]);

  useEffect(() => {
    fetchProductsFromShopify();
    loadBatches();
  }, [fetchProductsFromShopify, loadBatches]);

  // --------------------------------------------------------------------
  // Metafeld lesen & MHD vorschlagen
  // --------------------------------------------------------------------
  const suggestExpiryFromMetafield = useCallback(
    async (shopifyProductId) => {
      if (!shopifyProductId) return;

      try {
        const token = await getIdToken();
        const gql = {
          query: `
            query ($id: ID!) {
              product(id: $id) {
                shelfLife: metafield(namespace: "custom", key: "default_shelf_life_days") { value }
              }
            }
          `,
          variables: { id: shopifyProductId },
        };

        const resp = await fetch(`${BACKEND_URL}/api/graphql`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(gql),
        });

        const text = await resp.text();
        if (!resp.ok) {
          console.error('GraphQL error while suggesting expiry:', text?.slice(0, 300));
          return;
        }
        const json = JSON.parse(text);
        const daysStr = json?.data?.product?.shelfLife?.value;
        if (!daysStr) {
          setExpirySuggested(false);
          return;
        }

        const days = parseInt(daysStr, 10);
        if (Number.isFinite(days) && days > 0 && !expiryTouched) {
          const base = new Date();
          base.setHours(12, 0, 0, 0);
          base.setDate(base.getDate() + days);
          const iso = base.toISOString().slice(0, 10);
          setExpiryDate(iso);
          setExpirySuggested(true);
        }
      } catch (e) {
        console.error('Metafeld-Vorschlag fehlgeschlagen:', e);
      }
    },
    [BACKEND_URL, getIdToken, expiryTouched]
  );

  // Wenn im globalen Formular das Produkt gewechselt wird → MHD vorschlagen (wenn Feld nicht touched)
  const onSelectProduct = useCallback(
    (val) => {
      setSelectedShopifyProduct(val);
      // Vorschlag nur setzen, wenn MHD nicht manuell verändert wurde
      if (!expiryTouched) {
        suggestExpiryFromMetafield(val);
      }
    },
    [expiryTouched, suggestExpiryFromMetafield]
  );

  // Sobald Nutzer MHD editiert → nicht mehr überschreiben
  const onChangeExpiry = useCallback((val) => {
    setExpiryTouched(true);
    setExpirySuggested(false);
    setExpiryDate(val);
  }, []);

  // --------------------------------------------------------------------
  // Neue Charge anlegen
  // --------------------------------------------------------------------
  const handleCreateBatch = useCallback(async (explicitProductId) => {
    const productIdToUse = explicitProductId || selectedShopifyProduct;

    if (!productIdToUse) {
      setNotification({ status: 'critical', message: 'Bitte wählen Sie ein Produkt aus.' });
      return;
    }
    if (!batchNumber || !quantity) {
      setNotification({ status: 'critical', message: 'Chargennummer und Menge sind erforderlich.' });
      return;
    }
    setLoading(true);
    setNotification(null);

    // Produktdetails je nach Aufrufer bestimmen
    let productLabel = '';
    if (explicitProductId) {
      const p = productsTable.find((x) => x.id === explicitProductId);
      productLabel = p ? `${p.title} (SKU: ${p.sku || 'N/A'})` : '';
    } else {
      const p = shopifyProducts.find((x) => x.value === productIdToUse);
      productLabel = p?.label || '';
    }

    const payload = {
      shopifyProductId: productIdToUse,
      productName: productLabel.split(' (SKU:')[0] || '',
      productSku: productLabel.split('SKU: ')[1]?.replace(')', '') || '',
      batchNumber,
      expiryDate: expiryDate || null,
      quantity: parseInt(quantity, 10) || 0,
    };

    try {
      const data = await fetchWithAuth(`${BACKEND_URL}/api/batches`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setNotification({ status: 'success', message: `Charge ${data.batch.batch_number} erfolgreich erstellt!` });
      // Formular zurücksetzen
      setBatchNumber('');
      setExpiryDate('');
      setQuantity('');
      setSelectedShopifyProduct('');
      setExpiryTouched(false);
      setExpirySuggested(false);
      await loadBatches();
    } catch (error) {
      console.error(error);
      setNotification({ status: 'critical', message: error.message || 'Erstellen fehlgeschlagen.' });
    } finally {
      setLoading(false);
    }
  }, [selectedShopifyProduct, shopifyProducts, productsTable, batchNumber, expiryDate, quantity, BACKEND_URL, fetchWithAuth, loadBatches]);

  // --------------------------------------------------------------------
  // Bearbeiten / Löschen
  // --------------------------------------------------------------------
  const openEditModal = useCallback((batch) => {
    setBatchToEdit({
      id: batch.id,
      expiry_date: batch.expiry_date ? new Date(batch.expiry_date).toISOString().slice(0, 10) : '',
      quantity: batch.quantity ?? 0,
      batch_number: batch.batch_number,
    });
    setEditModalOpen(true);
  }, []);
  const closeEditModal = useCallback(() => {
    setEditModalOpen(false);
    setBatchToEdit(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!batchToEdit) return;
    setLoading(true);
    try {
      await fetchWithAuth(`${BACKEND_URL}/api/batches/${encodeURIComponent(batchToEdit.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          expiryDate: batchToEdit.expiry_date || null,
          quantity: batchToEdit.quantity ? parseInt(batchToEdit.quantity, 10) : 0,
        }),
      });
      setNotification({ status: 'success', message: 'Charge aktualisiert.' });
      closeEditModal();
      await loadBatches();
    } catch (error) {
      console.error(error);
      setNotification({ status: 'critical', message: error.message || 'Aktualisierung fehlgeschlagen.' });
    } finally {
      setLoading(false);
    }
  }, [batchToEdit, BACKEND_URL, fetchWithAuth, loadBatches, closeEditModal]);

  const requestDeleteBatch = useCallback((batch) => {
    setBatchToDelete(batch);
    setDeleteConfirmOpen(true);
  }, []);
  const closeDeleteConfirm = useCallback(() => {
    setDeleteConfirmOpen(false);
    setBatchToDelete(null);
  }, []);

  const performDelete = useCallback(async () => {
    if (!batchToDelete) return;
    setLoading(true);
    try {
      // Vorab-Check gegen Orders
      const batchNum = batchToDelete.batch_number;
      let hasOrders = false;
      try {
        const ordersResp = await fetchWithAuth(`${BACKEND_URL}/api/orders/batch/${encodeURIComponent(batchNum)}`);
        const orders = Array.isArray(ordersResp?.orders) ? ordersResp.orders : [];
        hasOrders = orders.length > 0;
      } catch (e) {
        if (e?.status && e.status !== 404) throw e; // echte Fehler
        hasOrders = false; // 404 = keine Bestellungen
      }

      if (hasOrders) {
        setNotification({
          status: 'critical',
          message: `Diese Charge (${batchNum}) kann nicht gelöscht werden, da bereits Bestellungen vorhanden sind.`,
        });
        return;
      }

      await fetchWithAuth(`${BACKEND_URL}/api/batches/${encodeURIComponent(batchToDelete.id)}`, {
        method: 'DELETE',
      });

      setNotification({ status: 'success', message: `Charge ${batchNum} wurde gelöscht.` });
      await loadBatches();
    } catch (error) {
      console.error(error);
      setNotification({ status: 'critical', message: error.message || 'Löschen fehlgeschlagen.' });
    } finally {
      setLoading(false);
      closeDeleteConfirm();
    }
  }, [batchToDelete, BACKEND_URL, fetchWithAuth, loadBatches, closeDeleteConfirm]);

  // --------------------------------------------------------------------
  // Rückverfolgung
  // --------------------------------------------------------------------
  const handleTraceBatch = useCallback(async () => {
    if (!searchBatch) return;
    setLoading(true);
    setNotification(null);
    setTraceResults([]);
    try {
      const data = await fetchWithAuth(`${BACKEND_URL}/api/orders/batch/${encodeURIComponent(searchBatch)}`);
      setTraceResults(Array.isArray(data.orders) ? data.orders : []);
    } catch (error) {
      console.error(error);
      if (error?.status === 404) {
        setNotification({ status: 'critical', message: `Keine Bestellungen für Charge ${searchBatch} gefunden.` });
      } else {
        setNotification({ status: 'critical', message: error.message || 'Suche fehlgeschlagen.' });
      }
    } finally {
      setLoading(false);
    }
  }, [searchBatch, BACKEND_URL, fetchWithAuth]);

  // --------------------------------------------------------------------
  // Produktbezogene Ansicht (Filterung)
  // --------------------------------------------------------------------
  const productBatches = useMemo(() => {
    if (!selectedProduct) return [];
    return batches.filter(
      (b) => b.shopify_product_id && b.shopify_product_id === selectedProduct.id
    );
  }, [batches, selectedProduct]);

  // --------------------------------------------------------------------
  // UI – Navigation
  // --------------------------------------------------------------------
  const navigationMarkup = (
    <Navigation location="/">
      <Navigation.Section
        items={[
          { label: 'Chargen verwalten', onClick: () => setCurrentPage('batches'), selected: currentPage === 'batches' },
          { label: 'Produkte', onClick: () => setCurrentPage('products'), selected: currentPage === 'products' },
          { label: 'Rückverfolgung', onClick: () => setCurrentPage('traceability'), selected: currentPage === 'traceability' },
        ]}
      />
    </Navigation>
  );

  // --- Reusable: Formular "Neue Charge" ---
  const NewBatchForm = ({ presetProductId, compact = false }) => {
    const effectiveProductId = presetProductId || selectedShopifyProduct;
    const disabled = !effectiveProductId || !batchNumber || !quantity || loading;

    // Vorschlag laden, wenn Formular mit presetProductId geöffnet wird oder sich die ID ändert
    useEffect(() => {
      if (presetProductId) {
        // Nur vorschlagen, wenn MHD nicht schon manuell gesetzt wurde
        if (!expiryTouched) {
          suggestExpiryFromMetafield(presetProductId);
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [presetProductId]);

    return (
      <Form onSubmit={() => handleCreateBatch(presetProductId)}>
        {!presetProductId && (
          <Select
            label="Shopify Produkt"
            options={[{ label: 'Produkt aus Ihrem Shop auswählen...', value: '' }, ...shopifyProducts]}
            onChange={onSelectProduct}
            value={selectedShopifyProduct}
          />
        )}
        <TextField label="Chargennummer" value={batchNumber} onChange={setBatchNumber} autoComplete="off" />
        <TextField
          label="MHD"
          value={expiryDate}
          onChange={onChangeExpiry}
          type="date"
          autoComplete="off"
          helpText={expirySuggested ? 'Vorschlag aus Metafeld custom.default_shelf_life_days' : undefined}
        />
        <TextField label="Menge" value={quantity} onChange={setQuantity} type="number" autoComplete="off" />
        <div style={{ marginTop: compact ? 12 : 20 }}>
          <Button submit primary disabled={disabled}>
            {loading ? 'Bitte warten…' : 'Charge erstellen'}
          </Button>
        </div>
      </Form>
    );
  };

  // --- Tabelle "Angelegte Chargen" ---
  const BatchesIndexTable = ({ rows }) => (
    <IndexTable
      resourceName={{ singular: 'Charge', plural: 'Chargen' }}
      itemCount={rows.length}
      selectable={false}
      headings={[
        { title: 'Chargennr.' },
        { title: 'Produkt' },
        { title: 'SKU' },
        { title: 'MHD' },
        { title: 'Menge' },
        { title: 'Aktionen' },
      ]}
    >
      {rows.map((b, index) => (
        <IndexTable.Row id={String(b.id)} key={b.id} position={index}>
          <IndexTable.Cell>
            <Text as="span" variant="bodyMd" fontWeight="semibold">{b.batch_number}</Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" variant="bodyMd">{b.product_name || '—'}</Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" variant="bodyMd">{b.sku || '—'}</Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Badge tone={b.expiry_date ? 'success' : 'attention'}>
              {b.expiry_date ? new Date(b.expiry_date).toLocaleDateString('de-DE') : 'kein Datum'}
            </Badge>
          </IndexTable.Cell>
          <IndexTable.Cell>{b.quantity}</IndexTable.Cell>
          <IndexTable.Cell>
            <InlineStack gap="200">
              <Button size="slim" onClick={() => openEditModal(b)}>Bearbeiten</Button>
              <Button size="slim" tone="critical" onClick={() => requestDeleteBatch(b)}>Löschen</Button>
            </InlineStack>
          </IndexTable.Cell>
        </IndexTable.Row>
      ))}
    </IndexTable>
  );

  // --- Seite: Chargen verwalten (global) ---
  const batchPageMarkup = (
    <Page title="Chargen verwalten">
      <Layout>
        <Layout.Section>
          <Card>
            <NewBatchForm />
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Box padding="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingMd">Angelegte Chargen</Text>
                {loadingBatches && <Spinner size="small" />}
              </InlineStack>
            </Box>
            {batches.length > 0 ? (
              <BatchesIndexTable rows={batches} />
            ) : (
              <EmptyState
                heading="Noch keine Chargen vorhanden"
                action={{ content: 'Neue Charge erstellen' }}
                image=""
              >
                <p>Lege die erste Charge über das Formular oben an.</p>
              </EmptyState>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      {/* Bearbeiten-Modal */}
      <Modal
        open={editModalOpen}
        onClose={closeEditModal}
        title={`Charge bearbeiten${batchToEdit?.batch_number ? ` – ${batchToEdit.batch_number}` : ''}`}
        primaryAction={{ content: 'Speichern', onAction: saveEdit, disabled: loading }}
        secondaryActions={[{ content: 'Abbrechen', onAction: closeEditModal }]}
      >
        <Modal.Section>
          <Form onSubmit={saveEdit}>
            <TextField
              label="MHD"
              value={batchToEdit?.expiry_date || ''}
              onChange={(val) => setBatchToEdit((prev) => ({ ...prev, expiry_date: val }))}
              type="date"
              autoComplete="off"
            />
            <TextField
              label="Menge"
              value={String(batchToEdit?.quantity ?? 0)}
              onChange={(val) => setBatchToEdit((prev) => ({ ...prev, quantity: parseInt(val || '0', 10) }))}
              type="number"
              autoComplete="off"
            />
          </Form>
        </Modal.Section>
      </Modal>

      {/* Löschbestätigung */}
      <Modal
        open={deleteConfirmOpen}
        onClose={closeDeleteConfirm}
        title="Charge löschen?"
        primaryAction={{ content: 'Ja, löschen', tone: 'critical', onAction: performDelete, disabled: loading }}
        secondaryActions={[{ content: 'Abbrechen', onAction: closeDeleteConfirm }]}
      >
        <Modal.Section>
          <Text as="p" variant="bodyMd">
            {batchToDelete
              ? `Soll die Charge "${batchToDelete.batch_number}" wirklich gelöscht werden?`
              : 'Soll diese Charge wirklich gelöscht werden?'}
          </Text>
          <Box paddingBlockStart="200">
            <Badge tone="critical">Achtung</Badge>{' '}
            <Text as="span" variant="bodySm">
              Löschen ist nicht möglich, wenn bereits Bestellungen zugeordnet sind. Das wird vorab geprüft und zusätzlich
              serverseitig verhindert.
            </Text>
          </Box>
        </Modal.Section>
      </Modal>
    </Page>
  );

  // --- Seite: Produkte (mit produktbezogener Charge-Anlage & Liste) ---
  const productsPageMarkup = (
    <Page title="Produkte">
      <Layout>
        <Layout.Section>
          <Card>
            <DataTable
              columnContentTypes={['text', 'text', 'text']}
              headings={['Titel', 'SKU', 'Aktionen']}
              rows={productsTable.map((p) => [
                p.title,
                p.sku,
                <Button onClick={() => {
                  setSelectedProduct(p);
                  // Vorschlag fürs MHD direkt vorbereiten (nur wenn noch nicht touched)
                  if (!expiryTouched) suggestExpiryFromMetafield(p.id);
                }}>
                  Chargen anzeigen
                </Button>,
              ])}
            />
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card title="Chargen zum ausgewählten Produkt">
            {!selectedProduct ? (
              <Box padding="400">
                <Text as="p" variant="bodyMd">Bitte ein Produkt oben auswählen.</Text>
              </Box>
            ) : (
              <>
                <Box padding="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <div>
                      <Text as="h3" variant="headingMd">{selectedProduct.title}</Text>
                      <Text as="p" variant="bodySm">SKU: {selectedProduct.sku || '—'}</Text>
                    </div>
                    <div>
                      <Button onClick={() => setSelectedProduct(null)} plain>Auswahl zurücksetzen</Button>
                    </div>
                  </InlineStack>
                </Box>

                <Divider />

                <Box padding="400">
                  <Text as="h4" variant="headingSm">Neue Charge für dieses Produkt anlegen</Text>
                </Box>
                <Box paddingInline="400" paddingBlockEnd="400">
                  {/* Gleiches Formular, aber mit presetProductId → MHD Vorschlag wird via useEffect geholt */}
                  <NewBatchForm presetProductId={selectedProduct.id} compact />
                </Box>

                <Divider />

                <Box padding="400">
                  <Text as="h4" variant="headingSm">Vorhandene Chargen</Text>
                </Box>
                {productBatches.length > 0 ? (
                  <BatchesIndexTable rows={productBatches} />
                ) : (
                  <Box padding="400">
                    <Text as="p" variant="bodyMd">Für dieses Produkt sind noch keine Chargen vorhanden.</Text>
                  </Box>
                )}
              </>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );

  // --- Seite: Rückverfolgung ---
  const traceabilityPageMarkup = (
    <Page title="Charge zurückverfolgen">
      <Card>
        <Form onSubmit={handleTraceBatch}>
          <TextField
            label="Chargennummer suchen"
            value={searchBatch}
            onChange={setSearchBatch}
            autoComplete="off"
          />
          <div style={{ marginTop: 12 }}>
            <Button submit primary disabled={loading || !searchBatch}>
              {loading ? 'Suche…' : 'Suchen'}
            </Button>
          </div>
        </Form>
      </Card>
      {traceResults.length > 0 && (
        <Card>
          <DataTable
            columnContentTypes={['text', 'text', 'text', 'text', 'numeric']}
            headings={['Bestell-ID', 'Kunde', 'Bestelldatum', 'Produkt', 'Menge']}
            rows={traceResults.map((order) => [
              order.orderId,
              order.customer,
              new Date(order.date).toLocaleDateString('de-DE'),
              order.productName,
              order.quantity,
            ])}
          />
        </Card>
      )}
    </Page>
  );

  const notificationBanner =
    notification ? (
      <Banner
        title={notification.status === 'success' ? 'Erfolg' : 'Fehler'}
        status={notification.status}
        onDismiss={() => setNotification(null)}
      >
        <p>{notification.message}</p>
      </Banner>
    ) : null;

  return (
    <Frame topBar={<TopBar />} navigation={navigationMarkup}>
      {notificationBanner}
      {loading && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(255,255,255,0.35)',
            zIndex: 999,
          }}
        >
          <Spinner />
        </div>
      )}
      {currentPage === 'batches' && batchPageMarkup}
      {currentPage === 'products' && productsPageMarkup}
      {currentPage === 'traceability' && traceabilityPageMarkup}
    </Frame>
  );
}

export default MyApp;
