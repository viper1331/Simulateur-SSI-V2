import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SsiSdk, type SiteTopology, type SiteZone } from '@simu-ssi/sdk';

export type DeviceKind = 'DM' | 'DAI' | 'DAS' | 'UGA';

interface DevicePlacement {
  id: string;
  label: string;
  kind: DeviceKind;
  xPercent: number;
  yPercent: number;
  zoneId?: string;
}

const DEVICE_DEFINITIONS: Record<
  DeviceKind,
  { label: string; shortLabel: string; description: string; color: string }
> = {
  DM: {
    label: 'Déclencheur manuel',
    shortLabel: 'DM',
    description: 'Point de déclenchement manuel de l’alarme incendie.',
    color: '#ef4444',
  },
  DAI: {
    label: 'Détecteur automatique',
    shortLabel: 'DAI',
    description: 'Capteur détectant fumées ou chaleur anormales.',
    color: '#f97316',
  },
  DAS: {
    label: 'Dispositif actionné de sécurité',
    shortLabel: 'DAS',
    description: 'Commande les ouvrants, clapets et autres actionneurs.',
    color: '#0ea5e9',
  },
  UGA: {
    label: 'Unité de gestion d’alarme',
    shortLabel: 'UGA',
    description: 'Pilote la diffusion sonore et visuelle de l’alarme.',
    color: '#8b5cf6',
  },
};

const DEVICE_ORDER: DeviceKind[] = ['DM', 'DAI', 'DAS', 'UGA'];

const formatCoordinate = (value: number) => `${value.toFixed(1)}%`;

const createDeviceId = (kind: DeviceKind) => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${kind}-${crypto.randomUUID()}`;
  }
  return `${kind}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
};

export function AdminStudioApp() {
  const baseUrl = useMemo(() => import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4500', []);
  const sdk = useMemo(() => new SsiSdk(baseUrl), [baseUrl]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const isMountedRef = useRef(true);
  const copyTimeoutRef = useRef<number | null>(null);
  const publishTimeoutRef = useRef<number | null>(null);

  const [planImage, setPlanImage] = useState<string | null>(null);
  const [planName, setPlanName] = useState<string>('Aucun plan importé');
  const [planNotes, setPlanNotes] = useState('');
  const [devices, setDevices] = useState<DevicePlacement[]>([]);
  const [selectedKind, setSelectedKind] = useState<DeviceKind | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [zones, setZones] = useState<SiteZone[]>([]);
  const [isLoadingTopology, setIsLoadingTopology] = useState(false);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [newZoneId, setNewZoneId] = useState('');
  const [newZoneLabel, setNewZoneLabel] = useState('');
  const [newZoneKind, setNewZoneKind] = useState('ZF');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [publishStatus, setPublishStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [publishError, setPublishError] = useState<string | null>(null);

  const hasWorkspaceContent = Boolean(planImage || devices.length > 0 || planNotes.trim().length > 0);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      if (publishTimeoutRef.current) {
        window.clearTimeout(publishTimeoutRef.current);
      }
    };
  }, []);

  const loadTopology = useCallback(async () => {
    if (!isMountedRef.current) {
      return;
    }
    setIsLoadingTopology(true);
    try {
      const topology = await sdk.getTopology();
      if (!isMountedRef.current) {
        return;
      }
      setZones(topology.zones);
      setTopologyError(null);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : "Impossible de récupérer la topologie actuelle.";
      setTopologyError(message);
    } finally {
      if (isMountedRef.current) {
        setIsLoadingTopology(false);
      }
    }
  }, [sdk]);

  useEffect(() => {
    loadTopology();
  }, [loadTopology]);

  useEffect(() => {
    if (copyStatus === 'idle') {
      return;
    }
    if (copyTimeoutRef.current) {
      window.clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = window.setTimeout(() => {
      setCopyStatus('idle');
    }, 2500);
  }, [copyStatus]);

  useEffect(() => {
    if (publishStatus !== 'success') {
      return;
    }
    if (publishTimeoutRef.current) {
      window.clearTimeout(publishTimeoutRef.current);
    }
    publishTimeoutRef.current = window.setTimeout(() => {
      setPublishStatus('idle');
    }, 2500);
  }, [publishStatus]);

  const handlePlanFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Le fichier doit être une image (PNG, JPG, SVG, …).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPlanImage(reader.result as string);
      setPlanName(file.name);
      setDevices([]);
      setPlanNotes('');
      setSelectedKind(null);
      setIsDragging(false);
    };
    reader.onerror = () => {
      alert("L'import du plan a échoué. Veuillez réessayer avec un autre fichier.");
      setIsDragging(false);
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePlanUpload = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        handlePlanFile(file);
      }
      event.target.value = '';
    },
    [handlePlanFile],
  );

  const handlePlanDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) {
        handlePlanFile(file);
      }
    },
    [handlePlanFile],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleStageClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!planImage || !selectedKind) {
        return;
      }
      const imageEl = imageRef.current;
      if (!imageEl) {
        return;
      }
      const rect = imageEl.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      if (Number.isNaN(x) || Number.isNaN(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        return;
      }
      setDevices((previous) => {
        const nextIndex = previous.filter((device) => device.kind === selectedKind).length + 1;
        const newDevice: DevicePlacement = {
          id: createDeviceId(selectedKind),
          label: `${DEVICE_DEFINITIONS[selectedKind].shortLabel} ${nextIndex}`,
          kind: selectedKind,
          xPercent: parseFloat((x * 100).toFixed(2)),
          yPercent: parseFloat((y * 100).toFixed(2)),
        };
        return [...previous, newDevice];
      });
    },
    [planImage, selectedKind],
  );

  const handleRemoveDevice = useCallback((id: string) => {
    setDevices((previous) => previous.filter((device) => device.id !== id));
  }, []);

  const handleRenameDevice = useCallback((id: string) => {
    setDevices((previous) => {
      const device = previous.find((item) => item.id === id);
      if (!device) {
        return previous;
      }
      const proposed = window.prompt('Nouveau libellé du dispositif', device.label);
      if (!proposed) {
        return previous;
      }
      const trimmed = proposed.trim();
      if (!trimmed) {
        return previous;
      }
      return previous.map((item) => (item.id === id ? { ...item, label: trimmed } : item));
    });
  }, []);

  const handleDeviceZoneChange = useCallback((deviceId: string, zoneId: string) => {
    setDevices((previous) =>
      previous.map((device) =>
        device.id === deviceId ? { ...device, zoneId: zoneId || undefined } : device,
      ),
    );
  }, []);

  const handleResetPlan = useCallback(() => {
    setPlanImage(null);
    setPlanName('Aucun plan importé');
    setPlanNotes('');
    setDevices([]);
    setSelectedKind(null);
    setIsDragging(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const markerStyle = useCallback(
    (device: DevicePlacement): CSSProperties => ({
      left: `${device.xPercent}%`,
      top: `${device.yPercent}%`,
      backgroundColor: DEVICE_DEFINITIONS[device.kind].color,
    }),
    [],
  );

  const handleAddZone = useCallback(() => {
    const trimmedId = newZoneId.trim();
    const trimmedLabel = newZoneLabel.trim();
    const trimmedKind = newZoneKind.trim();
    if (!trimmedId || !trimmedLabel || !trimmedKind) {
      alert('Renseignez un identifiant, un libellé et un type de zone.');
      return;
    }
    if (zones.some((zone) => zone.id === trimmedId)) {
      alert(`La zone « ${trimmedId} » existe déjà.`);
      return;
    }
    setZones((previous) => [...previous, { id: trimmedId, label: trimmedLabel, kind: trimmedKind }]);
    setNewZoneId('');
    setNewZoneLabel('');
  }, [newZoneId, newZoneLabel, newZoneKind, zones]);

  const handleZoneFieldChange = useCallback(
    (zoneId: string, field: 'label' | 'kind', value: string) => {
      setZones((previous) =>
        previous.map((zone) => (zone.id === zoneId ? { ...zone, [field]: value } : zone)),
      );
    },
    [],
  );

  const handleRemoveZone = useCallback((zoneId: string) => {
    setZones((previous) => previous.filter((zone) => zone.id !== zoneId));
    setDevices((previous) =>
      previous.map((device) => (device.zoneId === zoneId ? { ...device, zoneId: undefined } : device)),
    );
  }, []);

  const handleRefreshTopology = useCallback(() => {
    loadTopology();
  }, [loadTopology]);

  const siteTopology = useMemo<SiteTopology>(() => {
    const sanitizedZones = zones
      .map((zone) => ({
        id: zone.id.trim(),
        label: zone.label.trim(),
        kind: zone.kind.trim(),
      }))
      .filter((zone): zone is SiteZone => zone.id.length > 0 && zone.label.length > 0 && zone.kind.length > 0);

    const allowedZoneIds = new Set(sanitizedZones.map((zone) => zone.id));

    const sanitizedDevices = devices.map((device) => {
      const zoneId = device.zoneId && allowedZoneIds.has(device.zoneId) ? device.zoneId : undefined;
      const props: Record<string, unknown> = {
        coordinates: {
          xPercent: device.xPercent,
          yPercent: device.yPercent,
        },
      };
      if (planImage) {
        props.planName = planName;
      }
      if (planNotes.trim()) {
        props.planNotes = planNotes.trim();
      }
      const cleanedProps = Object.fromEntries(
        Object.entries(props).filter(([, value]) => value !== undefined),
      );

      return {
        id: device.id,
        kind: device.kind,
        zoneId,
        label: device.label,
        props: Object.keys(cleanedProps).length > 0 ? cleanedProps : undefined,
      };
    });

    return { zones: sanitizedZones, devices: sanitizedDevices };
  }, [zones, devices, planImage, planName, planNotes]);

  const hasTopologyContent = siteTopology.zones.length > 0 || siteTopology.devices.length > 0;
  const siteTopologyJson = useMemo(() => JSON.stringify(siteTopology, null, 2), [siteTopology]);

  const handleCopyTopology = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(siteTopologyJson);
      setCopyStatus('success');
    } catch (error) {
      console.error(error);
      setCopyStatus('error');
    }
  }, [siteTopologyJson]);

  const handlePublishTopology = useCallback(async () => {
    if (!hasTopologyContent || publishStatus === 'saving') {
      return;
    }
    setPublishStatus('saving');
    setPublishError(null);
    try {
      await sdk.updateTopology(siteTopology);
      setPublishStatus('success');
      setPublishError(null);
      void loadTopology();
    } catch (error) {
      console.error(error);
      const rawMessage = error instanceof Error ? error.message : 'La publication du plan a échoué.';
      const message = rawMessage.startsWith('UNKNOWN_ZONE:')
        ? `Un dispositif est associé à une zone inexistante (${rawMessage.split(':')[1] ?? 'zone inconnue'}).`
        : rawMessage;
      setPublishStatus('error');
      setPublishError(message);
    }
  }, [hasTopologyContent, loadTopology, publishStatus, sdk, siteTopology]);

  const isAddZoneDisabled = !newZoneId.trim() || !newZoneLabel.trim() || !newZoneKind.trim();
  const publishFeedbackMessage = publishStatus === 'success'
    ? 'Plan synchronisé avec les postes formateur et apprenant.'
    : publishStatus === 'error'
      ? publishError ?? 'La publication du plan a échoué.'
      : publishStatus === 'saving'
        ? 'Publication en cours…'
        : hasTopologyContent
          ? 'Publiez pour rendre ce plan disponible sur les autres postes.'
          : 'Ajoutez un plan et des dispositifs pour activer la publication.';

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1 className="app-title">Studio Administrateur</h1>
          <p className="app-subtitle">
            Importez vos plans, positionnez les dispositifs FPSSI et préparez vos scénarios pédagogiques.
          </p>
        </div>
        <div className="connection-hint">
          <span className="connection-label">Serveur connecté</span>
          <code className="connection-url">{baseUrl}</code>
        </div>
      </header>
      <div className="app-layout">
        <section className="panel plan-panel">
          <div className="panel-header">
            <h2>Plan interactif</h2>
            <span className="plan-name" title={planName}>
              {planName}
            </span>
          </div>
          <div
            className={`plan-stage${planImage ? '' : ' plan-stage--empty'}${isDragging ? ' plan-stage--dragging' : ''}`}
            onClick={handleStageClick}
            onDrop={handlePlanDrop}
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            {planImage ? (
              <div className="plan-image-wrapper">
                <img ref={imageRef} src={planImage} alt={`Plan ${planName}`} />
                <div className="plan-overlay">
                  {devices.map((device) => (
                    <button
                      key={device.id}
                      type="button"
                      className="device-marker"
                      style={markerStyle(device)}
                      title={`${device.label} — ${formatCoordinate(device.xPercent)}, ${formatCoordinate(device.yPercent)}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedKind(device.kind);
                      }}
                    >
                      {device.kind}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="plan-placeholder">
                <p>Glissez-déposez un plan ou utilisez le bouton ci-dessous.</p>
                <button type="button" className="button button-primary" onClick={handleImportClick}>
                  Importer un plan
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="visually-hidden"
              onChange={handlePlanUpload}
            />
          </div>
          <p className="stage-hint">
            {planImage
              ? selectedKind
                ? `Cliquez sur le plan pour placer un ${DEVICE_DEFINITIONS[selectedKind].label.toLowerCase()}.`
                : 'Sélectionnez un type de dispositif dans la palette pour commencer le placement.'
              : "Importez un plan pour activer l'espace de travail."}
          </p>
        </section>
        <aside className="control-sidebar">
          <section className="panel">
            <h2>Importation de plan</h2>
            <p>
              Chargez un plan d'évacuation (PNG, JPG ou SVG). L'import d'un nouveau plan réinitialise la liste des
              dispositifs.
            </p>
            <div className="button-row">
              <button type="button" className="button button-primary" onClick={handleImportClick}>
                Choisir un plan
              </button>
              <button type="button" className="button" onClick={handleResetPlan} disabled={!hasWorkspaceContent}>
                Réinitialiser
              </button>
            </div>
            {planImage && (
              <label className="field">
                <span className="field-label">Annotations sur le plan</span>
                <textarea
                  value={planNotes}
                  onChange={(event) => setPlanNotes(event.target.value)}
                  placeholder="Ajoutez des consignes, zones sensibles, numéros d'appel…"
                  rows={4}
                />
              </label>
            )}
          </section>
          <section className="panel">
            <h2>Palette de dispositifs</h2>
            <div className="device-palette">
              {DEVICE_ORDER.map((kind) => {
                const definition = DEVICE_DEFINITIONS[kind];
                const active = selectedKind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    className={`device-palette__item${active ? ' device-palette__item--active' : ''}`}
                    onClick={() => setSelectedKind(active ? null : kind)}
                    disabled={!planImage}
                  >
                    <span
                      className="device-palette__badge"
                      aria-hidden="true"
                      style={{ backgroundColor: definition.color }}
                    >
                      {kind}
                    </span>
                    <span className="device-palette__labels">
                      <strong>{definition.label}</strong>
                      <small>{definition.description}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="panel">
            <h2>Dispositifs placés</h2>
            {devices.length === 0 ? (
              <p className="empty-state">Aucun dispositif pour le moment.</p>
            ) : (
              <ul className="device-list">
                {devices.map((device) => (
                  <li key={device.id} className="device-list__item">
                    <div className="device-list__info">
                      <div className="device-list__meta">
                        <span
                          className="device-list__badge"
                          style={{ backgroundColor: DEVICE_DEFINITIONS[device.kind].color }}
                        >
                          {device.kind}
                        </span>
                        <div>
                          <strong>{device.label}</strong>
                          <span className="device-list__coordinates">
                            {formatCoordinate(device.xPercent)} · {formatCoordinate(device.yPercent)}
                          </span>
                        </div>
                      </div>
                      <label className="device-zone">
                        <span>Zone FPSSI</span>
                        <select
                          value={device.zoneId ?? ''}
                          onChange={(event) => handleDeviceZoneChange(device.id, event.target.value)}
                        >
                          <option value="">Sans zone</option>
                          {zones.map((zone) => (
                            <option key={zone.id} value={zone.id}>
                              {zone.label} ({zone.kind})
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="device-list__actions">
                      <button type="button" className="button button-ghost" onClick={() => handleRenameDevice(device.id)}>
                        Renommer
                      </button>
                      <button type="button" className="button button-ghost" onClick={() => handleRemoveDevice(device.id)}>
                        Supprimer
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>Zones FPSSI</h2>
              <div className="topology-status">
                {isLoadingTopology ? <span>Chargement…</span> : null}
                {topologyError ? (
                  <button type="button" className="button button-ghost" onClick={handleRefreshTopology}>
                    Réessayer
                  </button>
                ) : null}
              </div>
            </div>
            <p>
              Déclarez les zones FPSSI pour structurer la topologie. Les zones importées depuis le serveur peuvent être
              ajustées (libellé et type) avant d&apos;associer les dispositifs placés.
            </p>
            {topologyError ? <p className="error-message">{topologyError}</p> : null}
            <div className="zone-form">
              <div className="zone-form__grid">
                <label className="field">
                  <span className="field-label">Identifiant</span>
                  <input
                    type="text"
                    value={newZoneId}
                    onChange={(event) => setNewZoneId(event.target.value)}
                    placeholder="ZF1, ZF-RDC…"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Libellé</span>
                  <input
                    type="text"
                    value={newZoneLabel}
                    onChange={(event) => setNewZoneLabel(event.target.value)}
                    placeholder="Zone feu RDC"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Type</span>
                  <input
                    type="text"
                    value={newZoneKind}
                    onChange={(event) => setNewZoneKind(event.target.value)}
                    placeholder="ZF, ZS, TA…"
                  />
                </label>
              </div>
              <div className="button-row">
                <button type="button" className="button button-primary" onClick={handleAddZone} disabled={isAddZoneDisabled}>
                  Ajouter la zone
                </button>
              </div>
            </div>
            {zones.length === 0 ? (
              <p className="empty-state">Aucune zone n&apos;est définie pour le moment.</p>
            ) : (
              <ul className="zone-list">
                {zones.map((zone) => (
                  <li key={zone.id} className="zone-list__item">
                    <div className="zone-list__header">
                      <span className="zone-id">{zone.id}</span>
                      <div className="zone-list__actions">
                        <button type="button" className="button button-ghost" onClick={() => handleRemoveZone(zone.id)}>
                          Supprimer
                        </button>
                      </div>
                    </div>
                    <div className="zone-list__fields">
                      <label className="field">
                        <span className="field-label">Libellé</span>
                        <input
                          type="text"
                          value={zone.label}
                          onChange={(event) => handleZoneFieldChange(zone.id, 'label', event.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Type</span>
                        <input
                          type="text"
                          value={zone.kind}
                          onChange={(event) => handleZoneFieldChange(zone.id, 'kind', event.target.value)}
                        />
                      </label>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <h2>Export topologie FPSSI</h2>
            <p>
              Le JSON ci-dessous respecte le schéma <code>SiteTopology</code> du SDK et peut être envoyé directement au
              serveur du simulateur.
            </p>
            <div className="topology-preview">
              <textarea
                className="topology-preview__textarea"
                value={siteTopologyJson}
                readOnly
                rows={10}
                spellCheck={false}
              />
              <div className="topology-preview__actions">
                <div className="topology-preview__buttons">
                  <button
                    type="button"
                    className="button"
                    onClick={handleCopyTopology}
                    disabled={!hasTopologyContent}
                  >
                    Copier la topologie
                  </button>
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={handlePublishTopology}
                    disabled={!hasTopologyContent || publishStatus === 'saving'}
                  >
                    {publishStatus === 'saving' ? 'Publication…' : 'Mettre à disposition'}
                  </button>
                </div>
                <span className={`topology-copy-feedback topology-copy-feedback--${copyStatus}`}>
                  {copyStatus === 'success'
                    ? 'Topologie copiée dans le presse-papiers.'
                    : copyStatus === 'error'
                      ? 'La copie a échoué. Copiez manuellement le JSON.'
                      : hasTopologyContent
                        ? 'Ajustez zones et dispositifs avant export.'
                        : 'Ajoutez un plan et des dispositifs pour générer la topologie.'}
                </span>
                <span className={`topology-publish-feedback topology-publish-feedback--${publishStatus}`}>
                  {publishFeedbackMessage}
                </span>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
