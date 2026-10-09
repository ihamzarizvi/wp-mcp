<?php
/**
 * The WP MCP screen in WP Admin: connection details, settings and activity log.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WP_MCP_Bridge_Admin {
	const SLUG  = 'wp-mcp-bridge';
	const NONCE = 'wp_mcp_bridge_admin';

	/** Feedback for the current request: array( type, message ). */
	private static $notice = null;

	/** A just-created Application Password, shown once and never stored by the plugin. */
	private static $new_password = null;

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( WP_MCP_BRIDGE_FILE ), array( __CLASS__, 'action_links' ) );
	}

	public static function menu() {
		$hook = add_menu_page( 'WP MCP', 'WP MCP', 'manage_options', self::SLUG, array( __CLASS__, 'render' ), 'dashicons-rest-api', 81 );
		add_action( 'load-' . $hook, array( __CLASS__, 'handle_post' ) );
	}

	public static function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( self::url() ) . '">Settings</a>' );
		return $links;
	}

	private static function url( $tab = 'connection', array $args = array() ) {
		return add_query_arg( array_merge( array( 'page' => self::SLUG, 'tab' => $tab ), $args ), admin_url( 'admin.php' ) );
	}

	private static function tab() {
		$tab = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'connection'; // phpcs:ignore WordPress.Security.NonceVerification
		return in_array( $tab, array( 'connection', 'settings', 'activity' ), true ) ? $tab : 'connection';
	}

	/* --------------------------------------------------------------- actions */

	public static function handle_post() {
		if ( empty( $_POST['wp_mcp_action'] ) ) {
			return;
		}
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'You are not allowed to manage WP MCP.' );
		}
		check_admin_referer( self::NONCE );
		$action = sanitize_key( wp_unslash( $_POST['wp_mcp_action'] ) );
		$user   = wp_get_current_user();

		if ( 'save_settings' === $action ) {
			$input = isset( $_POST['wp_mcp'] ) && is_array( $_POST['wp_mcp'] ) ? wp_unslash( $_POST['wp_mcp'] ) : array(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
			WP_MCP_Bridge_Settings::save( $input );
			self::$notice = array( 'success', 'Settings saved.' );
		} elseif ( 'clear_log' === $action ) {
			WP_MCP_Bridge_Logger::clear();
			self::$notice = array( 'success', 'Activity log cleared.' );
		} elseif ( 'new_password' === $action ) {
			$name = isset( $_POST['app_name'] ) ? sanitize_text_field( wp_unslash( $_POST['app_name'] ) ) : '';
			$made = WP_Application_Passwords::create_new_application_password( $user->ID, array( 'name' => '' !== $name ? $name : 'wp-mcp' ) );
			if ( is_wp_error( $made ) ) {
				self::$notice = array( 'error', $made->get_error_message() );
			} else {
				self::$new_password = WP_Application_Passwords::chunk_password( $made[0] );
			}
		} elseif ( 'revoke_password' === $action ) {
			$uuid   = isset( $_POST['uuid'] ) ? sanitize_text_field( wp_unslash( $_POST['uuid'] ) ) : '';
			$result = WP_Application_Passwords::delete_application_password( $user->ID, $uuid );
			self::$notice = is_wp_error( $result ) ? array( 'error', $result->get_error_message() ) : array( 'success', 'Application Password revoked. Anything using it can no longer connect.' );
		}
	}

	private static function form_open( $action, $attrs = '' ) {
		echo '<form method="post" ' . $attrs . '>'; // phpcs:ignore WordPress.Security.EscapeOutput -- static markup from this class.
		wp_nonce_field( self::NONCE );
		echo '<input type="hidden" name="wp_mcp_action" value="' . esc_attr( $action ) . '">';
	}

	/* ---------------------------------------------------------------- render */

	public static function render() {
		$tab  = self::tab();
		$tabs = array( 'connection' => 'Connection', 'settings' => 'Settings', 'activity' => 'Activity' );
		?>
		<div class="wrap wp-mcp">
			<h1>WP MCP <span class="wp-mcp-version">Bridge <?php echo esc_html( WP_MCP_Bridge::VERSION ); ?></span></h1>
			<style>
				.wp-mcp-version{font-size:12px;font-weight:400;color:#646970;margin-left:6px}
				.wp-mcp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
				.wp-mcp-card{background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:14px 16px}
				.wp-mcp-card b{display:block;font-size:20px;line-height:1.3;margin-top:4px}
				.wp-mcp-card span{color:#646970}
				.wp-mcp pre{background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:12px;overflow:auto;max-width:860px}
				.wp-mcp h2{margin-top:28px}
				.wp-mcp .widefat{max-width:1100px}
				.wp-mcp-on{color:#007017;font-weight:600}.wp-mcp-off{color:#646970}.wp-mcp-bad{color:#b32d2e;font-weight:600}
				.wp-mcp-params{display:block;max-width:420px;max-height:5.4em;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px}
				.wp-mcp-steps li{margin-bottom:14px}
			</style>
			<?php if ( self::$notice ) : ?>
				<div class="notice notice-<?php echo esc_attr( self::$notice[0] ); ?> is-dismissible"><p><?php echo esc_html( self::$notice[1] ); ?></p></div>
			<?php endif; ?>
			<nav class="nav-tab-wrapper">
				<?php foreach ( $tabs as $key => $label ) : ?>
					<a class="nav-tab <?php echo $key === $tab ? 'nav-tab-active' : ''; ?>" href="<?php echo esc_url( self::url( $key ) ); ?>"><?php echo esc_html( $label ); ?></a>
				<?php endforeach; ?>
			</nav>
			<?php
			if ( 'settings' === $tab ) {
				self::render_settings();
			} elseif ( 'activity' === $tab ) {
				self::render_activity();
			} else {
				self::render_connection();
			}
			?>
		</div>
		<?php
	}

	private static function yes_no( $on, $yes = 'On', $no = 'Off' ) {
		return $on ? '<span class="wp-mcp-on">' . esc_html( $yes ) . '</span>' : '<span class="wp-mcp-off">' . esc_html( $no ) . '</span>';
	}

	private static function when( $gmt ) {
		if ( empty( $gmt ) ) {
			return 'Never';
		}
		$time = is_numeric( $gmt ) ? (int) $gmt : strtotime( $gmt . ' UTC' );
		return human_time_diff( $time, time() ) . ' ago';
	}

	/* ------------------------------------------------------------ connection */

	private static function render_connection() {
		$settings = WP_MCP_Bridge_Settings::all();
		$stats    = WP_MCP_Bridge_Logger::stats();
		$user     = wp_get_current_user();
		$host     = (string) wp_parse_url( home_url(), PHP_URL_HOST );
		$site_id  = sanitize_title( preg_replace( '/^www\./', '', $host ) );
		$env_name = 'WP_SITE_' . strtoupper( str_replace( '-', '_', $site_id ) ) . '_APP_PASSWORD';
		$can_app  = wp_is_application_passwords_available_for_user( $user );

		$entry = array(
			'id'             => $site_id,
			'url'            => untrailingslashit( home_url() ),
			'username'       => $user->user_login,
			'appPasswordEnv' => $env_name,
		);
		if ( '' === (string) get_option( 'permalink_structure' ) ) {
			$entry['plainPermalinks'] = true;
		}

		if ( ! $settings['enabled'] ) {
			echo '<div class="notice notice-error inline"><p><strong>MCP access is switched off.</strong> Every request from the wp-mcp server is refused until you turn it back on under Settings.</p></div>';
		} elseif ( $settings['read_only'] ) {
			echo '<div class="notice notice-warning inline"><p><strong>Read-only mode is on.</strong> The wp-mcp server can read this site but every change is refused.</p></div>';
		}
		?>
		<div class="wp-mcp-cards">
			<div class="wp-mcp-card"><span>Access</span><b><?php echo $settings['enabled'] ? ( $settings['read_only'] ? 'Read-only' : 'Full' ) : 'Off'; ?></b></div>
			<div class="wp-mcp-card"><span>Last logged request</span><b><?php echo esc_html( self::when( $stats['last'] ) ); ?></b></div>
			<div class="wp-mcp-card"><span>Logged requests, 24 h</span><b><?php echo esc_html( number_format_i18n( $stats['day'] ) ); ?></b></div>
			<div class="wp-mcp-card"><span>Errors, 24 h</span><b class="<?php echo $stats['errors'] ? 'wp-mcp-bad' : ''; ?>"><?php echo esc_html( number_format_i18n( $stats['errors'] ) ); ?></b></div>
		</div>
		<p class="description"><?php echo $settings['log_reads'] ? 'Every request from the wp-mcp server is logged.' : 'Only changes are logged. Turn on "Log read requests" under Settings to log everything.'; ?></p>

		<h2>Connect this site to the wp-mcp server</h2>
		<?php if ( ! $can_app ) : ?>
			<div class="notice notice-error inline"><p>Application Passwords are not available for your user on this site. They need HTTPS (or a local environment) and must not be disabled by a security plugin or the host. The wp-mcp server cannot log in without one.</p></div>
		<?php endif; ?>
		<ol class="wp-mcp-steps">
			<li>
				<strong>Create an Application Password</strong> for <code><?php echo esc_html( $user->user_login ); ?></code>. Use a dedicated administrator account for the agent if you can, so its actions are easy to trace and revoke.
				<?php if ( self::$new_password ) : ?>
					<div class="notice notice-success inline"><p><strong>Copy this now. It will not be shown again.</strong> Put this line in the <code>.env</code> file of the wp-mcp server:</p>
					<pre><?php echo esc_html( $env_name . '="' . self::$new_password . '"' ); ?></pre></div>
				<?php elseif ( $can_app ) : ?>
					<?php self::form_open( 'new_password', 'style="margin-top:8px"' ); ?>
						<input type="text" name="app_name" value="wp-mcp" class="regular-text" aria-label="Application Password name">
						<button class="button button-primary">Create Application Password</button>
					</form>
				<?php endif; ?>
			</li>
			<li>
				<strong>Add this entry</strong> to the <code>sites</code> list in <code>sites.json</code> on the machine running the wp-mcp server:
				<pre><?php echo esc_html( wp_json_encode( $entry, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) ); ?></pre>
			</li>
			<li>
				<strong>Add the password</strong> to the server's <code>.env</code> file, then restart your MCP client:
				<pre><?php echo esc_html( $env_name . '="xxxx xxxx xxxx xxxx xxxx xxxx"' ); ?></pre>
			</li>
		</ol>

		<h2>Application Passwords for <?php echo esc_html( $user->user_login ); ?></h2>
		<?php $passwords = WP_Application_Passwords::get_user_application_passwords( $user->ID ); ?>
		<?php if ( empty( $passwords ) ) : ?>
			<p>None yet.</p>
		<?php else : ?>
			<table class="widefat striped">
				<thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Last IP</th><th></th></tr></thead>
				<tbody>
				<?php foreach ( $passwords as $item ) : ?>
					<tr>
						<td><?php echo esc_html( $item['name'] ); ?></td>
						<td><?php echo esc_html( self::when( $item['created'] ) ); ?></td>
						<td><?php echo esc_html( self::when( $item['last_used'] ) ); ?></td>
						<td><?php echo esc_html( $item['last_ip'] ? $item['last_ip'] : '-' ); ?></td>
						<td>
							<?php self::form_open( 'revoke_password', 'onsubmit="return confirm(\'Revoke this Application Password? Anything using it will stop working.\')"' ); ?>
								<input type="hidden" name="uuid" value="<?php echo esc_attr( $item['uuid'] ); ?>">
								<button class="button button-link-delete">Revoke</button>
							</form>
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>

		<h2>What the agent can do here</h2>
		<table class="widefat striped">
			<thead><tr><th>Capability</th><th>Status</th><th>Controlled by</th></tr></thead>
			<tbody>
				<tr><td>Content, media, users, menus, plugins, settings, themes, options, post meta, Elementor, cron, cache</td><td><?php echo self::yes_no( $settings['enabled'] && ! $settings['read_only'], 'On', $settings['enabled'] ? 'Read-only' : 'Off' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></td><td>Settings tab</td></tr>
				<?php
				$labels = array( 'files' => 'Read and write files in wp-content', 'db' => 'Run SQL on the database', 'cli' => 'Run WP-CLI commands' );
				foreach ( $labels as $feature => $label ) :
					$locked = WP_MCP_Bridge_Settings::feature_locked( $feature );
					?>
					<tr>
						<td><?php echo esc_html( $label ); ?></td>
						<td><?php echo self::yes_no( WP_MCP_Bridge_Settings::feature_enabled( $feature ) ); // phpcs:ignore WordPress.Security.EscapeOutput ?></td>
						<td><?php echo $locked ? '<code>' . esc_html( WP_MCP_Bridge_Settings::FEATURES[ $feature ] ) . '</code> in wp-config.php' : 'Settings tab'; ?></td>
					</tr>
				<?php endforeach; ?>
			</tbody>
		</table>

		<h2>Environment</h2>
		<table class="widefat striped">
			<tbody>
				<tr><th>Site URL</th><td><code><?php echo esc_html( home_url() ); ?></code></td></tr>
				<tr><th>REST API</th><td><code><?php echo esc_html( rest_url() ); ?></code></td></tr>
				<tr><th>Bridge endpoint</th><td><code><?php echo esc_html( rest_url( WP_MCP_Bridge::NS ) ); ?></code></td></tr>
				<tr><th>WordPress / PHP</th><td><?php echo esc_html( get_bloginfo( 'version' ) . ' / ' . PHP_VERSION ); ?></td></tr>
				<tr><th>HTTPS</th><td><?php echo self::yes_no( is_ssl(), 'Yes', 'No' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></td></tr>
				<tr><th>Permalinks</th><td><?php echo '' === (string) get_option( 'permalink_structure' ) ? 'Plain (the entry above sets plainPermalinks)' : 'Pretty'; ?></td></tr>
				<tr><th>Application Passwords</th><td><?php echo self::yes_no( $can_app, 'Available', 'Unavailable' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></td></tr>
				<tr><th>WooCommerce</th><td><?php echo esc_html( defined( 'WC_VERSION' ) ? WC_VERSION : 'Not active' ); ?></td></tr>
				<tr><th>Elementor</th><td><?php echo esc_html( defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : 'Not active' ); ?></td></tr>
				<tr><th>WP-CLI from PHP</th><td><?php echo function_exists( 'proc_open' ) ? 'proc_open available, binary: <code>' . esc_html( defined( 'WP_MCP_CLI_PATH' ) ? WP_MCP_CLI_PATH : 'wp' ) . '</code>' : 'Not possible: this host disables proc_open'; ?></td></tr>
			</tbody>
		</table>
		<?php
	}

	/* -------------------------------------------------------------- settings */

	private static function checkbox( $key, $checked, $label, $help = '', $disabled = false ) {
		printf(
			'<label><input type="checkbox" name="wp_mcp[%1$s]" value="1" %2$s %3$s> %4$s</label>',
			esc_attr( $key ),
			checked( $checked, true, false ),
			disabled( $disabled, true, false ),
			esc_html( $label )
		);
		if ( '' !== $help ) {
			echo '<p class="description">' . wp_kses( $help, array( 'code' => array(), 'strong' => array() ) ) . '</p>';
		}
	}

	private static function render_settings() {
		$s = WP_MCP_Bridge_Settings::all();
		self::form_open( 'save_settings' );
		?>
		<h2>Access</h2>
		<table class="form-table" role="presentation">
			<tr><th scope="row">MCP access</th><td><?php self::checkbox( 'enabled', $s['enabled'], 'Allow the wp-mcp server to use this site', 'Turn this off to refuse every request from the wp-mcp server at once, without revoking any password.' ); ?></td></tr>
			<tr><th scope="row">Read-only mode</th><td><?php self::checkbox( 'read_only', $s['read_only'], 'Refuse every change', 'The agent can still read content and settings, but creating, editing and deleting are blocked on this site.' ); ?></td></tr>
			<tr>
				<th scope="row"><label for="wp-mcp-ips">Allowed IP addresses</label></th>
				<td>
					<textarea id="wp-mcp-ips" name="wp_mcp[allowed_ips]" rows="3" class="regular-text code" placeholder="Leave empty to allow any address"><?php echo esc_textarea( $s['allowed_ips'] ); ?></textarea>
					<p class="description">One address per line. Requests from the wp-mcp server are refused from anywhere else. Your current address is <code><?php echo esc_html( WP_MCP_Bridge_Settings::client_ip() ); ?></code>. If the site is behind a proxy or CDN, WordPress may see the proxy's address instead of the real one.</p>
				</td>
			</tr>
		</table>

		<h2>Powerful features</h2>
		<p>These are off by default. Each one lets the agent do things that can break the site, so enable only what you need.</p>
		<table class="form-table" role="presentation">
			<?php
			$features = array(
				'files' => array( 'Files', 'Read and write files inside wp-content', 'Theme and plugin code, uploads. A bad edit to an active PHP file can take the site down.' ),
				'db'    => array( 'Database', 'Run SQL statements', 'Direct queries against the WordPress database, including updates and deletes.' ),
				'cli'   => array( 'WP-CLI', 'Run WP-CLI commands', 'Needs WP-CLI installed on the server and a host that allows PHP to start processes.' ),
			);
			foreach ( $features as $feature => $text ) :
				$locked = WP_MCP_Bridge_Settings::feature_locked( $feature );
				$help   = $text[2] . ( $locked ? ' <strong>Set by <code>' . WP_MCP_Bridge_Settings::FEATURES[ $feature ] . '</code> in wp-config.php, so it cannot be changed here.</strong>' : '' );
				?>
				<tr><th scope="row"><?php echo esc_html( $text[0] ); ?></th><td><?php self::checkbox( 'allow_' . $feature, WP_MCP_Bridge_Settings::feature_enabled( $feature ), $text[1], $help, $locked ); ?></td></tr>
			<?php endforeach; ?>
		</table>

		<h2>Activity log</h2>
		<table class="form-table" role="presentation">
			<tr><th scope="row">Read requests</th><td><?php self::checkbox( 'log_reads', $s['log_reads'], 'Log read requests too', 'Changes are always logged. Logging reads as well gives a complete history but grows the log much faster.' ); ?></td></tr>
			<tr>
				<th scope="row"><label for="wp-mcp-days">Keep history for</label></th>
				<td><input id="wp-mcp-days" type="number" min="1" max="365" name="wp_mcp[retention_days]" value="<?php echo esc_attr( $s['retention_days'] ); ?>" class="small-text"> days</td>
			</tr>
		</table>
		<?php
		submit_button( 'Save settings' );
		echo '</form>';
	}

	/* -------------------------------------------------------------- activity */

	private static function render_activity() {
		// phpcs:disable WordPress.Security.NonceVerification -- read-only filters.
		$kind   = isset( $_GET['kind'] ) ? sanitize_key( wp_unslash( $_GET['kind'] ) ) : 'all';
		$search = isset( $_GET['s'] ) ? sanitize_text_field( wp_unslash( $_GET['s'] ) ) : '';
		$page   = isset( $_GET['paged'] ) ? max( 1, (int) $_GET['paged'] ) : 1;
		// phpcs:enable
		$per_page = 50;
		$result   = WP_MCP_Bridge_Logger::query( array( 'kind' => $kind, 'search' => $search, 'page' => $page, 'per_page' => $per_page ) );
		$filters  = array( 'all' => 'All', 'writes' => 'Changes', 'errors' => 'Errors' );
		$users    = array();
		?>
		<ul class="subsubsub">
			<?php
			$links = array();
			foreach ( $filters as $key => $label ) {
				$links[] = '<li><a class="' . ( $key === $kind ? 'current' : '' ) . '" href="' . esc_url( self::url( 'activity', array( 'kind' => $key ) ) ) . '">' . esc_html( $label ) . '</a>';
			}
			echo implode( ' |</li>', $links ) . '</li>'; // phpcs:ignore WordPress.Security.EscapeOutput -- escaped above.
			?>
		</ul>
		<form method="get"><p class="search-box">
			<input type="hidden" name="page" value="<?php echo esc_attr( self::SLUG ); ?>">
			<input type="hidden" name="tab" value="activity">
			<input type="hidden" name="kind" value="<?php echo esc_attr( $kind ); ?>">
			<input type="search" name="s" value="<?php echo esc_attr( $search ); ?>" placeholder="Route or details" aria-label="Search activity">
			<button class="button">Search</button>
		</p></form>
		<table class="widefat striped" style="clear:both">
			<thead><tr><th>When</th><th>User</th><th>Request</th><th>Result</th><th>Time</th><th>IP</th><th>Details</th></tr></thead>
			<tbody>
			<?php if ( empty( $result['rows'] ) ) : ?>
				<tr><td colspan="7">Nothing logged yet<?php echo ( 'all' !== $kind || '' !== $search ) ? ' for this filter' : ''; ?>.</td></tr>
			<?php endif; ?>
			<?php
			foreach ( $result['rows'] as $row ) :
				$uid = (int) $row['user_id'];
				if ( ! isset( $users[ $uid ] ) ) {
					$u             = $uid ? get_userdata( $uid ) : false;
					$users[ $uid ] = $u ? $u->user_login : 'not logged in';
				}
				$failed = (int) $row['status'] >= 400;
				?>
				<tr>
					<td title="<?php echo esc_attr( $row['created_at'] . ' UTC' ); ?>"><?php echo esc_html( get_date_from_gmt( $row['created_at'], 'Y-m-d H:i:s' ) ); ?></td>
					<td><?php echo esc_html( $users[ $uid ] ); ?><?php echo $row['app_name'] ? '<br><span class="description">' . esc_html( $row['app_name'] ) . '</span>' : ''; ?></td>
					<td><strong><?php echo esc_html( $row['method'] ); ?></strong> <code><?php echo esc_html( $row['route'] ); ?></code></td>
					<td class="<?php echo $failed ? 'wp-mcp-bad' : 'wp-mcp-on'; ?>"><?php echo esc_html( $row['status'] . ( $row['error_code'] ? ' ' . $row['error_code'] : '' ) ); ?></td>
					<td><?php echo esc_html( $row['duration_ms'] ); ?> ms</td>
					<td><?php echo esc_html( $row['ip'] ); ?></td>
					<td><code class="wp-mcp-params"><?php echo esc_html( (string) $row['params'] ); ?></code></td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<div class="tablenav bottom">
			<div class="alignleft actions">
				<?php self::form_open( 'clear_log', 'onsubmit="return confirm(\'Delete the whole activity log? This cannot be undone.\')"' ); ?>
					<button class="button button-link-delete">Clear log</button>
				</form>
			</div>
			<div class="tablenav-pages">
				<span class="displaying-num"><?php echo esc_html( number_format_i18n( $result['total'] ) ); ?> entries</span>
				<?php
				echo wp_kses_post(
					(string) paginate_links(
						array(
							'base'      => add_query_arg( 'paged', '%#%', self::url( 'activity', array( 'kind' => $kind, 's' => $search ) ) ),
							'format'    => '',
							'current'   => $page,
							'total'     => max( 1, (int) ceil( $result['total'] / $per_page ) ),
							'prev_text' => '&lsaquo;',
							'next_text' => '&rsaquo;',
						)
					)
				);
				?>
			</div>
		</div>
		<?php
	}
}
