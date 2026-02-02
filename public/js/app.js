const socket = io();

// Global state
let contacts = [];
let campaigns = [];
let templates = [];
let selectedContacts = [];

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
    setupEventListeners();
    checkWhatsAppStatus();
});

function initializeApp() {
    loadContacts();
    loadCampaigns();
    loadTemplates();
    loadAnalytics();
}

function setupEventListeners() {
    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.getAttribute('data-tab');
            switchTab(tabName);
        });
    });

    // Forms
    document.getElementById('addContactForm').addEventListener('submit', handleAddContact);
    document.getElementById('importForm').addEventListener('submit', handleImportContacts);
    document.getElementById('createCampaignForm').addEventListener('submit', handleCreateCampaign);
    document.getElementById('createTemplateForm').addEventListener('submit', handleCreateTemplate);

    // Logout button
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);

    // Socket events
    socket.on('qr', (qrCode) => {
        showQRCode(qrCode);
    });

    socket.on('ready', () => {
        updateConnectionStatus(true);
        closeModal('qrModal');
    });

    socket.on('authenticated', () => {
        console.log('WhatsApp authenticated');
    });

    socket.on('disconnected', () => {
        updateConnectionStatus(false);
    });

    socket.on('message_sent', (data) => {
        updateCampaignProgress(data);
    });
}

// Tab switching
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(tabName).classList.add('active');
}

// Check WhatsApp status
async function checkWhatsAppStatus() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();
        
        updateConnectionStatus(data.ready);
        
        if (!data.ready && data.qr) {
            showQRCode(data.qr);
        }
    } catch (error) {
        console.error('Error checking status:', error);
    }
}

function updateConnectionStatus(isConnected) {
    const indicator = document.getElementById('statusIndicator');
    const text = document.getElementById('statusText');
    const logoutBtn = document.getElementById('logoutBtn');
    
    if (isConnected) {
        indicator.className = 'status-dot connected';
        text.textContent = 'Connected';
        logoutBtn.style.display = 'block';
    } else {
        indicator.className = 'status-dot disconnected';
        text.textContent = 'Disconnected';
        logoutBtn.style.display = 'none';
    }
}

function showQRCode(qrCode) {
    const modal = document.getElementById('qrModal');
    const qrContainer = document.getElementById('qrCode');
    qrContainer.innerHTML = `<img src="${qrCode}" alt="QR Code">`;
    modal.style.display = 'block';
}

async function handleLogout() {
    if (!confirm('Are you sure you want to logout WhatsApp?')) return;
    
    try {
        await fetch('/api/logout', { method: 'POST' });
        updateConnectionStatus(false);
        alert('Logged out successfully');
    } catch (error) {
        alert('Error logging out: ' + error.message);
    }
}

// ==================== CONTACTS ====================

async function loadContacts() {
    try {
        const response = await fetch('/api/contacts');
        contacts = await response.json();
        renderContacts();
    } catch (error) {
        console.error('Error loading contacts:', error);
    }
}

function renderContacts() {
    const tbody = document.getElementById('contactsList');
    
    if (contacts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center">No contacts found</td></tr>';
        return;
    }
    
    tbody.innerHTML = contacts.map(contact => `
        <tr>
            <td><input type="checkbox" class="contact-checkbox" value="${contact.id}"></td>
            <td>${contact.name}</td>
            <td>${contact.phone}</td>
            <td>${contact.email || '-'}</td>
            <td>${contact.tags || '-'}</td>
            <td>
                <button class="btn btn-sm btn-secondary" onclick="editContact(${contact.id})">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-sm btn-danger" onclick="deleteContact(${contact.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

async function handleAddContact(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const data = {
        name: formData.get('name'),
        phone: formData.get('phone'),
        email: formData.get('email'),
        tags: formData.get('tags')?.split(',').map(t => t.trim()) || [],
        custom_fields: {}
    };
    
    try {
        const response = await fetch('/api/contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            closeModal('addContactModal');
            e.target.reset();
            loadContacts();
            showNotification('Contact added successfully', 'success');
        }
    } catch (error) {
        showNotification('Error adding contact: ' + error.message, 'error');
    }
}

async function handleImportContacts(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    
    try {
        const response = await fetch('/api/contacts/import', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (response.ok) {
            closeModal('importModal');
            e.target.reset();
            loadContacts();
            showNotification(`${result.imported} contacts imported successfully`, 'success');
        }
    } catch (error) {
        showNotification('Error importing contacts: ' + error.message, 'error');
    }
}

async function deleteContact(id) {
    if (!confirm('Are you sure you want to delete this contact?')) return;
    
    try {
        await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
        loadContacts();
        showNotification('Contact deleted successfully', 'success');
    } catch (error) {
        showNotification('Error deleting contact: ' + error.message, 'error');
    }
}

// ==================== CAMPAIGNS ====================

async function loadCampaigns() {
    try {
        const response = await fetch('/api/campaigns');
        campaigns = await response.json();
        renderCampaigns();
    } catch (error) {
        console.error('Error loading campaigns:', error);
    }
}

function renderCampaigns() {
    const tbody = document.getElementById('campaignsList');
    
    if (campaigns.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center">No campaigns found</td></tr>';
        return;
    }
    
    tbody.innerHTML = campaigns.map(campaign => {
        const statusBadge = getStatusBadge(campaign.status);
        return `
            <tr>
                <td>${campaign.name}</td>
                <td>${statusBadge}</td>
                <td>-</td>
                <td>-</td>
                <td>${new Date(campaign.created_at).toLocaleDateString()}</td>
                <td>
                    ${campaign.status === 'draft' || campaign.status === 'scheduled' ? 
                        `<button class="btn btn-sm btn-primary" onclick="startCampaign(${campaign.id})">
                            <i class="fas fa-play"></i> Start
                        </button>` : ''}
                    <button class="btn btn-sm btn-secondary" onclick="viewCampaign(${campaign.id})">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteCampaign(${campaign.id})">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

function getStatusBadge(status) {
    const badges = {
        'draft': '<span class="badge badge-info">Draft</span>',
        'scheduled': '<span class="badge badge-warning">Scheduled</span>',
        'running': '<span class="badge badge-info">Running</span>',
        'completed': '<span class="badge badge-success">Completed</span>',
        'paused': '<span class="badge badge-warning">Paused</span>'
    };
    return badges[status] || status;
}

async function handleCreateCampaign(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    
    // Get selected contacts
    const checkboxes = document.querySelectorAll('.campaign-contact-checkbox:checked');
    const contactIds = Array.from(checkboxes).map(cb => cb.value);
    
    if (contactIds.length === 0) {
        alert('Please select at least one contact');
        return;
    }
    
    formData.append('contacts', JSON.stringify(contactIds));
    
    try {
        const response = await fetch('/api/campaigns', {
            method: 'POST',
            body: formData
        });
        
        if (response.ok) {
            closeModal('createCampaignModal');
            e.target.reset();
            loadCampaigns();
            showNotification('Campaign created successfully', 'success');
        }
    } catch (error) {
        showNotification('Error creating campaign: ' + error.message, 'error');
    }
}

async function startCampaign(id) {
    if (!confirm('Are you sure you want to start this campaign?')) return;
    
    try {
        const response = await fetch(`/api/campaigns/${id}/start`, {
            method: 'POST'
        });
        
        if (response.ok) {
            loadCampaigns();
            showNotification('Campaign started successfully', 'success');
        }
    } catch (error) {
        showNotification('Error starting campaign: ' + error.message, 'error');
    }
}

async function deleteCampaign(id) {
    if (!confirm('Are you sure you want to delete this campaign?')) return;
    
    try {
        await fetch(`/api/campaigns/${id}`, { method: 'DELETE' });
        loadCampaigns();
        showNotification('Campaign deleted successfully', 'success');
    } catch (error) {
        showNotification('Error deleting campaign: ' + error.message, 'error');
    }
}

function updateCampaignProgress(data) {
    console.log('Message sent:', data);
    // You can update UI here to show real-time progress
}

// ==================== TEMPLATES ====================

async function loadTemplates() {
    try {
        const response = await fetch('/api/templates');
        templates = await response.json();
        renderTemplates();
        updateTemplateSelect();
    } catch (error) {
        console.error('Error loading templates:', error);
    }
}

function renderTemplates() {
    const container = document.getElementById('templatesList');
    
    if (templates.length === 0) {
        container.innerHTML = '<div class="text-center">No templates found</div>';
        return;
    }
    
    container.innerHTML = templates.map(template => `
        <div class="template-card">
            <h4>${template.name}</h4>
            <p>${template.content.substring(0, 100)}...</p>
            <div>
                <button class="btn btn-sm btn-secondary" onclick="useTemplate(${template.id})">
                    <i class="fas fa-check"></i> Use Template
                </button>
                <button class="btn btn-sm btn-danger" onclick="deleteTemplate(${template.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function updateTemplateSelect() {
    const select = document.getElementById('templateSelect');
    select.innerHTML = '<option value="">-- Start from scratch --</option>' +
        templates.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
}

async function handleCreateTemplate(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const data = {
        name: formData.get('name'),
        content: formData.get('content'),
        variables: ['name', 'phone', 'email']
    };
    
    try {
        const response = await fetch('/api/templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            closeModal('createTemplateModal');
            e.target.reset();
            loadTemplates();
            showNotification('Template created successfully', 'success');
        }
    } catch (error) {
        showNotification('Error creating template: ' + error.message, 'error');
    }
}

async function deleteTemplate(id) {
    if (!confirm('Are you sure you want to delete this template?')) return;
    
    try {
        await fetch(`/api/templates/${id}`, { method: 'DELETE' });
        loadTemplates();
        showNotification('Template deleted successfully', 'success');
    } catch (error) {
        showNotification('Error deleting template: ' + error.message, 'error');
    }
}

function loadTemplate() {
    const select = document.getElementById('templateSelect');
    const templateId = select.value;
    
    if (!templateId) return;
    
    const template = templates.find(t => t.id == templateId);
    if (template) {
        document.querySelector('[name="message"]').value = template.content;
    }
}

// ==================== ANALYTICS ====================

async function loadAnalytics() {
    try {
        const response = await fetch('/api/analytics');
        const stats = await response.json();
        
        document.getElementById('totalContacts').textContent = stats.totalContacts || 0;
        document.getElementById('totalCampaigns').textContent = stats.totalCampaigns || 0;
        document.getElementById('messagesSent').textContent = stats.messagesSent || 0;
        document.getElementById('messagesFailed').textContent = stats.messagesFailed || 0;
    } catch (error) {
        console.error('Error loading analytics:', error);
    }
}

// ==================== MODALS ====================

function openAddContactModal() {
    document.getElementById('addContactModal').style.display = 'block';
}

function openImportModal() {
    document.getElementById('importModal').style.display = 'block';
}

async function openCreateCampaignModal() {
    await loadContacts();
    
    const selector = document.getElementById('campaignContactSelector');
    selector.innerHTML = contacts.map(contact => `
        <div class="contact-item">
            <input type="checkbox" class="campaign-contact-checkbox" value="${contact.id}">
            <span>${contact.name} - ${contact.phone}</span>
        </div>
    `).join('');
    
    document.getElementById('createCampaignModal').style.display = 'block';
}

function openCreateTemplateModal() {
    document.getElementById('createTemplateModal').style.display = 'block';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

// Close modal when clicking outside
window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
}

function toggleSchedule() {
    const checkbox = document.getElementById('scheduleCheckbox');
    const group = document.getElementById('scheduleGroup');
    group.style.display = checkbox.checked ? 'block' : 'none';
}

// ==================== UTILITIES ====================

function showNotification(message, type = 'info') {
    // Simple alert for now - you can implement a better notification system
    alert(message);
}

function copyToClipboard(elementId) {
    const element = document.getElementById(elementId);
    const text = element.textContent;
    
    navigator.clipboard.writeText(text).then(() => {
        showNotification('Copied to clipboard!', 'success');
    });
}

// Auto-refresh analytics every 30 seconds
setInterval(loadAnalytics, 30000);
