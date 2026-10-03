import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { 
  Car, Clock, CheckCircle2, ChevronLeft, Image as ImageIcon,
  Calendar, MapPin, Wrench, ShieldCheck, Info
} from 'lucide-react';
import PageHeader from '../../components/PageHeader';
import LoadingState from '../../components/LoadingState';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import toast from 'react-hot-toast';
import PhotoProofGallery from '../../components/Photos/PhotoProofGallery';
import { fetchVehiclePhotos, resolvePhotoUrls } from '../../services/photoService';
import { fetchStaffBookings } from '../../utils/notificationRouting';

const StaffJobDetails = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const [unit, setUnit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [photoGalleryOpen, setPhotoGalleryOpen] = useState(false);
  const [evidencePhotos, setEvidencePhotos] = useState([]);

  useEffect(() => {
    fetchJobDetails();
  }, [fetchJobDetails]);

  useEffect(() => {
    if (!unit?.id) return;
    let cancelled = false;
    const loadEvidence = async () => {
      const rows = await fetchVehiclePhotos(id);
      const photos = await resolvePhotoUrls(rows);
      if (!cancelled) setEvidencePhotos(photos.filter((photo) => photo.url));
    };
    loadEvidence().catch((error) => {
      console.error('Job Evidence Error:', error);
      toast.error('Failed to load service evidence');
    });
    return () => { cancelled = true; };
  }, [id, unit?.id]);

  const fetchJobDetails = useCallback(async () => {
    setLoading(true);
    try {
      const bookings = await fetchStaffBookings(supabase, { vehicleId: id });
      const booking = bookings[0];
      const vehicle = booking?.vehicles?.find((item) => item.id === id);
      if (!booking || !vehicle) {
        toast.error('This vehicle is not available in your assigned work.');
        navigate('/staff/tasks', { replace: true });
        return;
      }
      setUnit({
        ...vehicle,
        booking: {
          id: booking.id,
          status: booking.status,
          start_datetime: booking.start_datetime,
          end_datetime: booking.end_datetime
        }
      });
    } catch (err) {
      console.error('Job Details Error:', err);
      toast.error('Failed to load job details');
      navigate('/staff/history');
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  if (loading) return <LoadingState message="Retrieving service logs..." />;
  if (!unit) return null;

  const cardStyle = {
    background: 'var(--admin-card)',
    border: '1px solid var(--admin-border)',
    borderRadius: '8px',
    padding: '2rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem'
  };

  const labelStyle = {
    fontSize: '0.65rem',
    fontWeight: '950',
    color: 'var(--admin-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '1.5px',
    marginBottom: '0.5rem'
  };

  const dataStyle = {
    fontSize: '1rem',
    fontWeight: '700',
    color: 'var(--admin-text-primary)'
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <button
        onClick={() => navigate(-1)}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          background: 'none', border: 'none', color: 'var(--admin-text-secondary)',
          fontSize: '0.75rem', fontWeight: '950', cursor: 'pointer',
          textTransform: 'uppercase', letterSpacing: '1px', alignSelf: 'flex-start'
        }}
      >
        <ChevronLeft size={16} /> Return to Queue
      </button>

      <PageHeader
        badge={`UNIT ID: ${unit.id.slice(0, 8).toUpperCase()}`}
        title="Service Verification"
        subtitle="Reviewing technical specifications and operational timestamps for this unit."
      />

      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '2rem' }}>

        <div style={{ flex: 1.5, display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          {/* Vehicle Specifications */}
          <section style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '1rem' }}>
              <Car size={20} color="var(--admin-brand)" />
              <h3 style={{ margin: 0, fontSize: '0.85rem', fontWeight: '950', textTransform: 'uppercase' }}>Vehicle Specifications</h3>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
              <div>
                <div style={labelStyle}>Brand & Model</div>
                <div style={dataStyle}>{unit.brand} {unit.model}</div>
              </div>
              <div>
                <div style={labelStyle}>Plate Number</div>
                <div style={{ ...dataStyle, color: 'var(--admin-brand)' }}>{unit.plate_number}</div>
              </div>
              <div>
                <div style={labelStyle}>Vehicle Type</div>
                <div style={dataStyle}>{unit.vehicle_type || 'STANDARD'}</div>
              </div>
              <div>
                <div style={labelStyle}>Fleet Category</div>
                <div style={dataStyle}>{unit.is_fleet ? 'COMMERCIAL FLEET' : 'PRIVATE PASSENGER'}</div>
              </div>
            </div>
          </section>

          {/* Service Package */}
          <section style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '1rem' }}>
              <ShieldCheck size={20} color="var(--status-success)" />
              <h3 style={{ margin: 0, fontSize: '0.85rem', fontWeight: '950', textTransform: 'uppercase' }}>Assigned Detailing Services</h3>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
              {unit.services?.map((s, i) => (
                <div key={i} style={{ flex: '1 1 200px', background: 'var(--admin-bg)', padding: '1rem', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.03)' }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: '900', color: 'var(--admin-text-primary)' }}>{s.service_name}</div>
                  <div style={{ fontSize: '0.65rem', color: '#444', fontWeight: '700', marginTop: '0.25rem' }}>PROFESSIONAL GRADE</div>
                </div>
              ))}
            </div>
            {unit.service_notes && (
              <div style={{ marginTop: '1rem', padding: '1rem', background: 'var(--admin-bg)', borderRadius: '4px', borderLeft: '3px solid var(--admin-brand)' }}>
                <div style={labelStyle}>Technical Observations</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>{unit.service_notes}</div>
              </div>
            )}
          </section>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          {/* Operational Timestamps */}
          <section style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '1rem' }}>
              <Clock size={20} color="var(--status-warning)" />
              <h3 style={{ margin: 0, fontSize: '0.85rem', fontWeight: '950', textTransform: 'uppercase' }}>Operational Timestamps</h3>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div>
                <div style={labelStyle}>Scheduled Start</div>
                <div style={{ ...dataStyle, fontSize: '0.9rem' }}>
                  {new Date(unit.booking?.start_datetime).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                </div>
              </div>
              <div>
                <div style={labelStyle}>Service Commencement</div>
                <div style={{ ...dataStyle, fontSize: '0.9rem', color: unit.started_at ? 'var(--status-success)' : 'var(--admin-text-secondary)' }}>
                  {unit.started_at ? new Date(unit.started_at).toLocaleString('en-US', { timeStyle: 'medium' }) : 'NOT RECORDED'}
                </div>
              </div>
              <div>
                <div style={labelStyle}>Final Completion</div>
                <div style={{ ...dataStyle, fontSize: '0.9rem', color: unit.completed_at ? 'var(--status-success)' : 'var(--admin-text-secondary)' }}>
                  {unit.completed_at ? new Date(unit.completed_at).toLocaleString('en-US', { timeStyle: 'medium' }) : 'NOT RECORDED'}
                </div>
              </div>
            </div>
          </section>

          {/* Evidence Preview */}
          <section style={cardStyle}>
            <div style={labelStyle}>Quality Assurance Proof</div>
            <button
              type="button"
              onClick={() => setPhotoGalleryOpen(true)}
              style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: '0.45rem', padding: '0.6rem 0.85rem', background: 'transparent', border: '1px solid var(--admin-brand)', borderRadius: 'var(--admin-radius-sm)', color: 'var(--admin-brand)', fontSize: '0.68rem', fontWeight: 900, textTransform: 'uppercase', cursor: 'pointer' }}
            >
              <ImageIcon size={14} /> View Before/After Evidence
            </button>
            {evidencePhotos.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: '0.5rem' }}>
                {evidencePhotos.slice(0, 6).map((photo) => (
                  <button
                    key={photo.id}
                    type="button"
                    onClick={() => setPhotoGalleryOpen(true)}
                    aria-label={`View ${photo.phase} service photo`}
                    style={{ padding: 0, aspectRatio: '1 / 1', overflow: 'hidden', border: '1px solid var(--admin-border)', borderRadius: '4px', background: 'var(--admin-bg)', cursor: 'pointer' }}
                  >
                    <img src={photo.url} alt={photo.caption || `${photo.phase} service evidence`} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ height: '150px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', background: 'var(--admin-bg)', borderRadius: '4px', border: '1px dashed rgba(255,255,255,0.1)' }}>
                <Info size={24} color="#333" />
                <div style={{ fontSize: '0.65rem', color: '#444', fontWeight: '950' }}>NO EVIDENCE PHOTOS AVAILABLE</div>
              </div>
            )}
          </section>
        </div>

      </div>
      <PhotoProofGallery
        bookingId={unit.booking_id}
        bookingVehicleId={unit.id}
        open={photoGalleryOpen}
        onClose={() => setPhotoGalleryOpen(false)}
      />
    </div>
  );
};

export default StaffJobDetails;
